/**
 * Tag scanner + resolver for [@zotero:...] placeholders.
 *
 * Syntax:
 *   [@zotero:ABCD1234]              Zotero item key (8-char alphanumeric)
 *   [@zotero:10.1038/nature12373]   DOI
 *   [@zotero:pmid:29028643]         PubMed ID (numbers are ambiguous so we
 *                                   require the explicit prefix)
 *   [@zotero:?author year topic]    Free-text library search (top hit)
 *   [@zotero:find]                  v0.2: LLM-assisted discovery
 *
 * Optional locator after a pipe: [@zotero:ABCD1234|p. 42]
 *
 * Resolution writes Zotero's plain-text "transfer document" format inline
 * (an `ITEM CSL_CITATION {...}` block per citation, plus a transfer header
 * and DOCUMENT_PREFERENCES footer). On the user's next Zotero Refresh, the
 * Connector converts every block to a real citation field.
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
  // [@zotero:find], [@zotero:find?support], [@zotero:find?n=3]
  if (id === 'find' || id.indexOf('find?') === 0 || id.indexOf('find ') === 0) {
    const opts = { mode: 'any', n: 3 };
    const q = id.indexOf('?');
    if (q >= 0) {
      const params = id.substring(q + 1).split('&');
      params.forEach(p => {
        const eq = p.indexOf('=');
        if (eq < 0) {
          if (p === 'support' || p === 'contradict') opts.mode = p;
        } else {
          const k = p.substring(0, eq).trim();
          const v = p.substring(eq + 1).trim();
          if (k === 'n') opts.n = Math.max(1, Math.min(10, parseInt(v, 10) || 3));
          if (k === 'mode') opts.mode = v;
        }
      });
    }
    return { kind: 'find', id: 'find', locator, mode: opts.mode, n: opts.n };
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
  // Fall-through: anything else is treated as a free-text library search.
  // This catches Better BibTeX citekeys (e.g. "zhangReviewQuestion2021"),
  // partial titles, author+year fragments, etc. BBT writes the citekey into
  // the Zotero Extra field, which qmode=everything searches.
  return { kind: 'query', id: id, locator };
}

function Resolver_findTags() {
  const doc = DocumentApp.getActiveDocument();
  const body = doc.getBody();
  const out = [];
  const numEls = body.getNumChildren();
  function walk(el, paragraphIndex) {
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
          paragraphIndex: paragraphIndex,
          kind: cls.kind,
          id: cls.id,
          locator: cls.locator,
          mode: cls.mode,
          n: cls.n
        });
      }
    } else if (el.getNumChildren) {
      const n = el.getNumChildren();
      for (let i = 0; i < n; i++) walk(el.getChild(i), paragraphIndex);
    }
  }
  for (let i = 0; i < numEls; i++) walk(body.getChild(i), i);
  return out;
}

/**
 * Resolve every non-find tag to an inline ITEM CSL_CITATION block, then
 * ensure the transfer header + DOCUMENT_PREFERENCES are present.
 *
 * Tags are processed in REVERSE document order so earlier offsets stay
 * valid as we mutate text in place.
 */
function Resolver_resolveAll(settings) {
  const tags = Resolver_findTags().filter(t => t.kind !== 'find');
  tags.sort((a, b) => b.start - a.start);

  const report = { ok: true, resolved: 0, failed: 0, items: [] };

  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    try {
      const res = Resolver_resolveOne(t, settings);
      report.resolved++;
      report.items.push({
        raw: t.raw,
        status: 'ok',
        paragraph: t.paragraphIndex,
        title: res.title
      });
    } catch (e) {
      report.failed++;
      report.items.push({
        raw: t.raw,
        status: 'error',
        paragraph: t.paragraphIndex,
        error: String(e.message || e)
      });
    }
  }

  // Insert / verify the transfer-document header + DOCUMENT_PREFERENCES.
  if (report.resolved > 0) {
    try { ZoteroTransfer_ensureMarkers(settings.defaultStyle); }
    catch (e) {
      report.ok = false;
      report.error = 'Inserted citations but failed to add transfer markers: ' + (e.message || e);
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
    if (!hit) {
      throw new Error(
        'DOI ' + tag.id + ' not found in: ' + ZoteroApi_describeLibraries(settings) +
        '. Possible causes: (1) the item is not saved in Zotero yet, (2) it lives in a ' +
        'group library you have not added in Settings, (3) your Zotero API key was created ' +
        'without access to that group — check zotero.org/settings/keys and tick the group.'
      );
    }
    lookup = { csl: hit.csl, itemUri: hit.itemUri };
  } else if (tag.kind === 'pmid') {
    const doi = PubMed_pmidToDoi(tag.id);
    if (!doi) throw new Error('PMID ' + tag.id + ' has no DOI on PubMed.');
    const hit = ZoteroApi_findByDoi(doi, settings);
    if (!hit) throw new Error('PMID ' + tag.id + ' (DOI ' + doi + ') not found in: ' + ZoteroApi_describeLibraries(settings));
    lookup = { csl: hit.csl, itemUri: hit.itemUri };
  } else if (tag.kind === 'query') {
    // Order matters: for strings with no whitespace (classic citekey or
    // identifier shape like "240618027AutomatedClinical"), try the
    // Extra-field citekey lookup FIRST. Otherwise the q-search could
    // return a partial-title match of some other paper (e.g. any paper
    // with "Automated" or "Clinical" in its title) and we'd silently
    // resolve to the wrong item. For multi-word queries, q-search first
    // is still the right choice (cheap and usually precise).
    const looksLikeCitekey = !/\s/.test(tag.id);
    let lookupErr = null;
    if (looksLikeCitekey) {
      const ck = ZoteroApi_findByCitekey(tag.id, settings);
      if (ck) {
        lookup = { csl: ck.csl, itemUri: ck.itemUri };
      } else {
        const hits = ZoteroApi_search(tag.id, settings, 1);
        if (hits.length) {
          lookup = { csl: hits[0].csl, itemUri: hits[0].itemUri };
        } else {
          lookupErr = 'No match by Better BibTeX citekey in Extra field, and no q-search hit.';
        }
      }
    } else {
      const hits = ZoteroApi_search(tag.id, settings, 1);
      if (hits.length) {
        lookup = { csl: hits[0].csl, itemUri: hits[0].itemUri };
      } else {
        const ck = ZoteroApi_findByCitekey(tag.id, settings);
        if (ck) {
          lookup = { csl: ck.csl, itemUri: ck.itemUri };
        } else {
          lookupErr = 'No q-search hit (title/creators/year) and no Extra-field citekey match.';
        }
      }
    }
    if (!lookup) {
      throw new Error(
        'No library match for "' + tag.id + '" in: ' +
        ZoteroApi_describeLibraries(settings) + '. ' + lookupErr +
        ' Make sure the item exists in one of these libraries and has the ' +
        '"Citation Key: ' + tag.id + '" line in its Extra field (BBT adds this automatically).'
      );
    }
  } else {
    throw new Error('Unrecognized tag kind: ' + tag.kind);
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

  const block = ZoteroTransfer_buildItemBlock(lookup.csl, lookup.itemUri, locOpts);
  ZoteroTransfer_insertAt(tag.textElement, tag.start, tag.end, block);
  return { title: lookup.csl.title || '(untitled)' };
}
