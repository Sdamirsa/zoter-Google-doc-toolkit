/**
 * v0.4 — [@zotero:find] inline 3-reference replacement.
 *
 * For each [@zotero:find] tag in the document:
 *   1. Extract context = surrounding paragraphs.
 *   2. Ask Claude (with web_search) for exactly three peer-reviewed papers
 *      classified as:
 *        - "orig"   — original/primary research SUPPORTING the claim
 *        - "rev"    — a review paper SUPPORTING the claim
 *        - "contra" — a paper questioning, contradicting, or warning
 *                     against the claim (for balance)
 *   3. Replace the [@zotero:find] tag INLINE with a compact parenthetical
 *      containing the three references, each hyperlinked to its DOI/URL:
 *
 *        (Smith 2022 [orig]; Brown 2021 [rev]; Jones 2023 [contra])
 *
 *   4. Render a card in the sidebar per tag showing the three refs with
 *      titles, DOIs, and Claude's per-call API cost.
 *
 * These are RESEARCH SUGGESTIONS, not finalized Zotero citations. The
 * researcher reviews them manually and decides what to keep. If they want
 * a proper Zotero-managed citation, they save the paper to Zotero, then
 * write a new [@zotero:KEY] tag and run Resolve.
 *
 * The inserted parentheticals are plain hyperlinked text — they are NOT
 * wrapped in ZOTERO_TRANSFER_DOCUMENT markers. Zotero's importer only
 * looks for ITEM CSL_CITATION / BIBL / DOCUMENT_PREFERENCES hyperlinked
 * prefixes (see docs/ZOTERO_INTEGRATION_INTERNALS.md §5), so these
 * hyperlinks are invisible to Zotero Refresh — which is exactly what we
 * want: they coexist peacefully with any real [@zotero:KEY] citations in
 * the same document.
 */

const FIND_CACHE_TTL = 600; // seconds

function Find_cacheFailedKey(docId) { return 'zoter_find_failed_' + docId; }

function Find_getDocId() {
  return DocumentApp.getActiveDocument().getId();
}

/**
 * Walk paragraphs to find which one contains the tag, and return the
 * previous, current, and next paragraph text.
 */
function Find_extractContext(tag) {
  const body = DocumentApp.getActiveDocument().getBody();
  const num = body.getNumChildren();
  const parIdx = tag.paragraphIndex;
  const safe = (i) => (i >= 0 && i < num) ? Find_paragraphText(body.getChild(i)) : '';
  const current = safe(parIdx);
  const before = safe(parIdx - 1);
  const after = safe(parIdx + 1);
  return { before, current, after };
}

function Find_paragraphText(el) {
  if (!el) return '';
  if (typeof el.getText === 'function') {
    try { return el.getText(); } catch (e) { return ''; }
  }
  return '';
}

/** Build the system prompt asking for exactly 3 classified references. */
function Find_systemPrompt() {
  return [
    'You are a scientific citation finder assisting a researcher writing a paper.',
    '',
    'Task: the researcher has marked a sentence with [@zotero:find] to request',
    'three peer-reviewed references around a specific claim. Your job:',
    '',
    '1. Read the surrounding paragraphs and identify the specific scientific',
    '   claim being made.',
    '2. Use the web_search tool to find peer-reviewed sources. Prefer PubMed,',
    '   PubMed Central, Nature, Science, Cell, recent reviews, and primary',
    '   literature. Avoid blogs, non-peer-reviewed preprints, and predatory',
    '   journals.',
    '3. Return EXACTLY THREE papers, one of each kind:',
    '     "orig"   — an original / primary research paper that SUPPORTS the claim',
    '     "rev"    — a review or meta-analysis that SUPPORTS the claim',
    '     "contra" — a paper that QUESTIONS, CONTRADICTS, or WARNS against the claim',
    '   The "contra" reference is critical — it gives the researcher a balanced',
    '   perspective and a counterpoint to review.',
    '4. Every paper must have a verifiable DOI. If no DOI exists, include a',
    '   direct peer-reviewed URL instead.',
    '',
    'OUTPUT RULES (strict):',
    '- Your FINAL message MUST be a JSON array inside a ```json fenced block.',
    '- No prose after the closing fence.',
    '- Minimize reasoning narration before the JSON — search, then answer.',
    '',
    'Each object in the array must have exactly these fields:',
    '  kind          — "orig" | "rev" | "contra"',
    '  author        — first-author last name, e.g. "Smith"',
    '  year          — number',
    '  title         — string',
    '  venue         — journal/book title',
    '  doi           — string (null only if you have a URL instead)',
    '  url           — fallback URL if and only if no DOI is known; null otherwise',
    '  justification — one sentence explaining how this paper relates to the claim',
    '',
    'If you genuinely cannot find a paper in one category after a thorough search,',
    'omit that object — but try hard first. The researcher values the contra slot.',
    '',
    'Example final response (content illustrative only):',
    '```json',
    '[',
    '  {"kind":"orig","author":"Smith","year":2022,"title":"...","venue":"Nature",',
    '   "doi":"10.1038/...","url":null,"justification":"Direct experimental test of the claim in a 2022 cohort."},',
    '  {"kind":"rev","author":"Brown","year":2021,"title":"...","venue":"Annu Rev Biophys",',
    '   "doi":"10.1146/...","url":null,"justification":"Systematic review covering 18 primary studies."},',
    '  {"kind":"contra","author":"Jones","year":2023,"title":"...","venue":"NEJM",',
    '   "doi":"10.1056/...","url":null,"justification":"Cohort study reporting the opposite effect."}',
    ']',
    '```'
  ].join('\n');
}

/** Build the user message with the surrounding-context paragraphs. */
function Find_userMessage(ctx) {
  return [
    'Paragraph before the target sentence:',
    ctx.before || '(none)',
    '',
    'Paragraph containing the target sentence (look for [@zotero:find]):',
    ctx.current || '(none)',
    '',
    'Paragraph after:',
    ctx.after || '(none)'
  ].join('\n');
}

/* ============================================================================
 * Streaming driver — called repeatedly from the sidebar until `done: true`.
 * Each call processes at most one [@zotero:find] tag.
 * ============================================================================ */

function Find_findNext(settings) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) {
    return { ok: false, error: 'A Find operation is already running on this document. Wait and retry.' };
  }
  try {
    const cache = CacheService.getDocumentCache();
    const docId = Find_getDocId();
    const failKey = Find_cacheFailedKey(docId);
    const failed = JSON.parse(cache.get(failKey) || '[]');
    const failedSet = {};
    failed.forEach(k => failedSet[k] = true);

    const allTags = Resolver_findTags().filter(t => t.kind === 'find');
    const todo = allTags.filter(t => !failedSet[t.raw + '@' + t.paragraphIndex]);

    if (!todo.length) {
      cache.remove(failKey);
      return { ok: true, done: true, remaining: 0 };
    }

    // Process highest-offset tag first so earlier offsets stay valid as
    // we mutate the text in place (same invariant as Resolver_resolveAll).
    todo.sort((a, b) => b.start - a.start);
    const t = todo[0];
    const totalRemaining = todo.length;

    const ctx = Find_extractContext(t);
    const llm = Llm_callClaudeWithSearch(Find_systemPrompt(), Find_userMessage(ctx), settings);

    const tagResult = {
      raw: t.raw,
      paragraph: t.paragraphIndex,
      excerpt: (ctx.current || '').slice(0, 220),
      refs: [],
      inserted: false,
      error: null,
      cost: llm.cost || 0,
      usage: llm.usage || null
    };

    if (!llm.ok) {
      tagResult.error = llm.error;
      failed.push(t.raw + '@' + t.paragraphIndex);
      cache.put(failKey, JSON.stringify(failed), FIND_CACHE_TTL);
      return {
        ok: true,
        done: totalRemaining === 1,
        remaining: totalRemaining - 1,
        processed: tagResult
      };
    }
    if (!llm.json || !Array.isArray(llm.json)) {
      const hint = llm.parseError ? (' [' + llm.parseError + ']') : '';
      tagResult.error = 'Claude did not return a JSON array' + hint +
        '. First 400 chars: ' + (llm.text || '').slice(0, 400);
      failed.push(t.raw + '@' + t.paragraphIndex);
      cache.put(failKey, JSON.stringify(failed), FIND_CACHE_TTL);
      return {
        ok: true,
        done: totalRemaining === 1,
        remaining: totalRemaining - 1,
        processed: tagResult
      };
    }

    // Normalize + validate Claude's refs. Accept only refs with a DOI or URL.
    const refs = llm.json.map(c => Find_normalizeRef(c)).filter(r => r && r.url);
    // Sort by kind order: orig, rev, contra.
    const order = { orig: 0, rev: 1, contra: 2 };
    refs.sort((a, b) => (order[a.kind] || 9) - (order[b.kind] || 9));
    tagResult.refs = refs;

    if (!refs.length) {
      tagResult.error = 'Claude returned candidates but none had a DOI or URL; nothing inserted.';
      failed.push(t.raw + '@' + t.paragraphIndex);
      cache.put(failKey, JSON.stringify(failed), FIND_CACHE_TTL);
      return {
        ok: true,
        done: totalRemaining === 1,
        remaining: totalRemaining - 1,
        processed: tagResult
      };
    }

    // Build + insert the inline parenthetical in place of the tag.
    const built = Find_buildInlineCitation(refs);
    Find_insertInlineCitation(t.textElement, t.start, t.end, built);
    tagResult.inserted = true;
    tagResult.inlineText = built.text;

    return {
      ok: true,
      done: totalRemaining === 1,
      remaining: totalRemaining - 1,
      processed: tagResult
    };
  } finally {
    lock.releaseLock();
  }
}

function Find_clearCache() {
  const cache = CacheService.getDocumentCache();
  cache.remove(Find_cacheFailedKey(Find_getDocId()));
}

/* ============================================================================
 * Ref normalization + URL resolution
 * ============================================================================ */

function Find_normalizeRef(c) {
  if (!c || typeof c !== 'object') return null;
  const kindRaw = String(c.kind || '').toLowerCase();
  let kind = 'contra';
  if (kindRaw === 'orig' || kindRaw === 'original' || kindRaw === 'primary') kind = 'orig';
  else if (kindRaw === 'rev' || kindRaw === 'review' || kindRaw === 'meta' || kindRaw === 'metaanalysis') kind = 'rev';
  else if (kindRaw === 'contra' || kindRaw === 'contradict' || kindRaw === 'against' || kindRaw === 'contradicts' || kindRaw === 'warning') kind = 'contra';

  const doi = c.doi ? String(c.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim() : null;
  const url = c.url && String(c.url).trim() || null;

  let finalUrl = null;
  if (doi) finalUrl = 'https://doi.org/' + doi;
  else if (url) finalUrl = url;

  return {
    kind: kind,
    author: c.author || 'Anon',
    year: c.year || null,
    title: c.title || '(untitled)',
    venue: c.venue || '',
    doi: doi,
    url: finalUrl,
    justification: c.justification || ''
  };
}

/* ============================================================================
 * Inline citation builder + in-place inserter
 * ============================================================================ */

/**
 * Build the replacement text for a [@zotero:find] tag.
 * Output: { text: "(Smith 2022 [orig]; Brown 2021 [rev]; Jones 2023 [contra])",
 *           links: [{start, end, url}, ...] }
 * Each link covers only the "Author Year" span, not the label.
 */
function Find_buildInlineCitation(refs) {
  const kindLabel = { orig: 'orig', rev: 'rev', contra: 'contra' };
  let text = '(';
  const links = [];
  refs.forEach((ref, i) => {
    if (i > 0) text += '; ';
    const nameYear = ref.author + ' ' + (ref.year != null ? ref.year : 'n.d.');
    const linkStart = text.length;
    text += nameYear;
    const linkEnd = text.length - 1;
    if (ref.url) links.push({ start: linkStart, end: linkEnd, url: ref.url });
    text += ' [' + (kindLabel[ref.kind] || ref.kind) + ']';
  });
  text += ')';
  return { text: text, links: links };
}

/**
 * Replace textElement[start..endInclusive] with the inline-citation text and
 * apply the per-reference hyperlinks at the correct offsets.
 */
function Find_insertInlineCitation(textElement, startOffset, endOffsetInclusive, built) {
  const original = textElement.getText();
  const before = original.substring(0, startOffset);
  const after = original.substring(endOffsetInclusive + 1);
  textElement.setText(before + built.text + after);
  const base = before.length;
  built.links.forEach(l => {
    textElement.setLinkUrl(base + l.start, base + l.end, l.url);
  });
}
