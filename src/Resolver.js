/**
 * Tag scanner + resolver for [@zotero:...] placeholders.
 *
 * Syntax (smart auto-detect, error-proof):
 *   [@zotero:ABCD1234]              Zotero item key (8-char alphanumeric)
 *   [@zotero:10.1038/nature12373]   DOI (starts with "10.")
 *   [@zotero:pmid:29028643]         PubMed ID (explicit prefix; numbers are
 *                                   ambiguous so we require the prefix)
 *   [@zotero:?author year topic]    Free-text library search (interactive)
 *
 * Optional locator after a pipe:
 *   [@zotero:ABCD1234|p. 42]
 *   [@zotero:10.1038/foo|pp. 10-12]
 *
 * Pipe separator chosen because DOIs and queries contain commas/colons.
 */

const TAG_RE = /\[@zotero:([^\]]+)\]/g;

function Resolver_classify(idRaw) {
  let id = idRaw.trim();
  let locator = '';
  const pipe = id.indexOf('|');
  if (pipe >= 0) {
    locator = id.substring(pipe + 1).trim();
    id = id.substring(0, pipe).trim();
  }
  if (id.indexOf('?') === 0) {
    return { kind: 'query', id: id.substring(1).trim(), locator };
  }
  if (id.toLowerCase().indexOf('pmid:') === 0) {
    return { kind: 'pmid', id: id.substring(5).trim(), locator };
  }
  if (id.indexOf('10.') === 0 && id.indexOf('/') > 0) {
    return { kind: 'doi', id: id, locator };
  }
  if (/^[A-Z0-9]{8}$/.test(id)) {
    return { kind: 'key', id: id, locator };
  }
  return { kind: 'unknown', id: id, locator };
}

/**
 * Walk the document body, return all tag occurrences with their text element
 * + offsets so we can replace them in place.
 */
function Resolver_findTags() {
  const doc = DocumentApp.getActiveDocument();
  const body = doc.getBody();
  const out = [];
  const numEls = body.getNumChildren();
  function walk(el) {
    const type = el.getType();
    if (type === DocumentApp.ElementType.TEXT) {
      const text = el.asText().getText();
      let m;
      const re = new RegExp(TAG_RE.source, 'g');
      while ((m = re.exec(text)) !== null) {
        const cls = Resolver_classify(m[1]);
        out.push({
          raw: m[0],
          start: m.index,
          end: m.index + m[0].length - 1,
          textElement: el.asText(),
          kind: cls.kind,
          id: cls.id,
          locator: cls.locator
        });
      }
    } else if (el.getNumChildren) {
      const n = el.getNumChildren();
      for (let i = 0; i < n; i++) walk(el.getChild(i));
    }
  }
  for (let i = 0; i < numEls; i++) walk(body.getChild(i));
  return out;
}

/**
 * Resolve every [@zotero:...] tag we can. Returns a per-tag report.
 *
 * IMPORTANT: we resolve in REVERSE document order so earlier offsets stay
 * valid as we mutate text.
 */
function Resolver_resolveAll(settings) {
  const tags = Resolver_findTags();
  // Reverse so later tags are mutated first.
  tags.sort((a, b) => b.start - a.start);

  const report = { ok: true, resolved: 0, failed: 0, items: [] };

  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    try {
      const res = Resolver_resolveOne(t, settings);
      report.resolved++;
      report.items.push({ raw: t.raw, status: 'ok', title: res.title });
    } catch (e) {
      report.failed++;
      report.items.push({ raw: t.raw, status: 'error', error: String(e.message || e) });
    }
  }
  return report;
}

function Resolver_resolveOne(tag, settings) {
  let lookup;
  if (tag.kind === 'key') {
    lookup = ZoteroApi_getItemByKey(tag.id, settings);
  } else if (tag.kind === 'doi') {
    const hit = ZoteroApi_findByDoi(tag.id, settings);
    if (!hit) throw new Error('DOI ' + tag.id + ' not found in your Zotero library. Save it via the Zotero Connector first.');
    lookup = { csl: hit.csl, itemUri: hit.itemUri };
  } else if (tag.kind === 'pmid') {
    const doi = PubMed_pmidToDoi(tag.id);
    if (!doi) throw new Error('PMID ' + tag.id + ' has no DOI on PubMed.');
    const hit = ZoteroApi_findByDoi(doi, settings);
    if (!hit) throw new Error('PMID ' + tag.id + ' (DOI ' + doi + ') not found in your Zotero library.');
    lookup = { csl: hit.csl, itemUri: hit.itemUri };
  } else if (tag.kind === 'query') {
    const hits = ZoteroApi_search(tag.id, settings, 1);
    if (!hits.length) throw new Error('No library hits for "' + tag.id + '".');
    lookup = { csl: hits[0].csl, itemUri: hits[0].itemUri };
  } else {
    throw new Error('Unrecognized tag id: ' + tag.id);
  }

  // Optional locator parsing
  let locOpts = {};
  if (tag.locator) {
    const m = tag.locator.match(/^(p+\.?|pp\.?|chap\.?|sec\.?|fig\.?)\s*(.+)$/i);
    if (m) {
      locOpts.label = m[1].toLowerCase().replace(/\.$/, '').replace(/^pp?$/, 'page');
      locOpts.locator = m[2].trim();
    } else {
      locOpts.locator = tag.locator;
    }
  }

  const fieldCode = ZoteroField_buildFieldCode(lookup.csl, lookup.itemUri, locOpts);
  const display = ZoteroField_renderPlaceholder(lookup.csl) +
                  (locOpts.locator ? ' [' + (locOpts.label || '') + ' ' + locOpts.locator + ']' : '');
  ZoteroField_insertAt(tag.textElement, tag.start, tag.end, fieldCode, display);
  return { title: lookup.csl.title || '(untitled)' };
}
