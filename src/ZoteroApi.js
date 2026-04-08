/**
 * Thin client for api.zotero.org (Web API v3).
 *
 * Searches the user's personal library AND any group libraries the user
 * lists in Settings (`zoteroGroupIds`, comma-separated). Items in group
 * libraries are NOT visible from /users/<uid>/items, so groups must be
 * queried separately.
 */

const ZOTERO_API_BASE = 'https://api.zotero.org';

function ZoteroApi_fetchJson(path, settings) {
  const url = ZOTERO_API_BASE + path;
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Zotero-API-Version': '3',
      'Authorization': 'Bearer ' + settings.zoteroApiKey
    },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Zotero API ' + code + ': ' + res.getContentText().slice(0, 200));
  }
  return JSON.parse(res.getContentText());
}

/** Parse the comma-separated zoteroGroupIds setting into an array. */
function ZoteroApi_groupIds(settings) {
  if (!settings.zoteroGroupIds) return [];
  return String(settings.zoteroGroupIds)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Build the list of (libraryType, libraryId) pairs to search. */
function ZoteroApi_libraries(settings) {
  const out = [];
  if (settings.zoteroUserId) out.push({ type: 'users', id: settings.zoteroUserId });
  ZoteroApi_groupIds(settings).forEach(gid => out.push({ type: 'groups', id: gid }));
  return out;
}

function ZoteroApi_libUri(lib, key) {
  return 'http://zotero.org/' + lib.type + '/' + lib.id + '/items/' + key;
}

/**
 * Fetch a single item by Zotero key. Searches the user library first, then
 * each configured group. Returns {csl, itemUri} or throws.
 */
function ZoteroApi_getItemByKey(key, settings) {
  const libs = ZoteroApi_libraries(settings);
  let lastErr = null;
  for (const lib of libs) {
    try {
      const path = '/' + lib.type + '/' + encodeURIComponent(lib.id) +
                   '/items/' + encodeURIComponent(key) +
                   '?format=json&include=csljson,data';
      const r = ZoteroApi_fetchJson(path, settings);
      if (r && r.csljson) {
        return { csl: r.csljson, itemUri: ZoteroApi_libUri(lib, key) };
      }
    } catch (e) {
      lastErr = e;
      // 404 in user library is normal when item lives in a group — keep going.
    }
  }
  throw new Error('Item ' + key + ' not found in your library or configured groups. ' + (lastErr ? '(' + lastErr.message + ')' : ''));
}

/**
 * Search every configured library. Returns array of {key, csl, itemUri, title, library}.
 */
function ZoteroApi_search(query, settings, limit) {
  limit = limit || 5;
  const libs = ZoteroApi_libraries(settings);
  const out = [];
  for (const lib of libs) {
    try {
      const path = '/' + lib.type + '/' + encodeURIComponent(lib.id) +
                   '/items?q=' + encodeURIComponent(query) +
                   '&qmode=everything&limit=' + limit +
                   '&format=json&include=csljson,data';
      const rows = ZoteroApi_fetchJson(path, settings);
      (rows || []).forEach(row => {
        out.push({
          key: row.key,
          csl: row.csljson,
          data: row.data,
          itemUri: ZoteroApi_libUri(lib, row.key),
          title: (row.data && row.data.title) || (row.csljson && row.csljson.title) || '(untitled)',
          library: lib
        });
      });
    } catch (e) { /* skip libraries that error */ }
  }
  return out;
}

/** Normalize a DOI: strip URL prefix, "doi:", trim, lowercase. */
function ZoteroApi_normalizeDoi(s) {
  if (!s) return '';
  s = String(s).toLowerCase().trim();
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
  s = s.replace(/^doi:\s*/, '');
  return s.trim();
}

/**
 * Extract a DOI from an arbitrary string (e.g. an Extra field that contains
 * "DOI: 10.1145/3468889" or just the DOI on its own line).
 */
function ZoteroApi_extractDoiFromText(s) {
  if (!s) return '';
  const m = String(s).match(/10\.\d{4,9}\/[^\s"<>]+/);
  return m ? ZoteroApi_normalizeDoi(m[0]) : '';
}

/**
 * Pull every DOI candidate out of a search hit. Checks csljson.DOI,
 * data.DOI, and data.extra (some item types — and many BBT-imported items —
 * only store the DOI in Extra).
 */
function ZoteroApi_collectDois(hit) {
  const out = [];
  if (hit.csl && hit.csl.DOI) out.push(ZoteroApi_normalizeDoi(hit.csl.DOI));
  if (hit.data && hit.data.DOI) out.push(ZoteroApi_normalizeDoi(hit.data.DOI));
  if (hit.data && hit.data.extra) {
    const fromExtra = ZoteroApi_extractDoiFromText(hit.data.extra);
    if (fromExtra) out.push(fromExtra);
  }
  return out.filter(Boolean);
}

/**
 * Find an item by DOI. The Zotero Web API `q` parameter only searches
 * title/creators/year/tags/notes — NOT the DOI field or the Extra field —
 * so we have to iterate the library page-by-page and match locally.
 *
 * Sorted by dateModified desc so recently-added items (the ones you're
 * usually citing) are found in the first page or two. Capped at
 * ITERATE_MAX items per library to bound the request count.
 */
function ZoteroApi_findByDoi(doi, settings) {
  return ZoteroApi_iterateLibrariesMatching(settings, function(row) {
    const norm = ZoteroApi_normalizeDoi(doi);
    const dois = ZoteroApi_collectDois({ csl: row.csljson, data: row.data });
    if (dois.indexOf(norm) >= 0) {
      // If csljson.DOI was empty (DOI lived in Extra), patch it back so the
      // citation Zotero generates on Refresh has the DOI populated.
      const csl = row.csljson || {};
      if (!csl.DOI) csl.DOI = norm;
      return csl;
    }
    return null;
  });
}

/**
 * Find an item by Better BibTeX citekey. BBT writes the citekey to the
 * Extra field; historically in several different formats:
 *   Citation Key: <key>
 *   tex.citationkey: <key>
 *   Citekey: <key>
 * Match all of them, case-insensitive, with a non-word boundary after the
 * key so trailing digits don't leak into the next line.
 */
function ZoteroApi_findByCitekey(citekey, settings) {
  const escaped = citekey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '(?:Citation\\s*Key|tex\\.citation[-_]?key|Citekey)\\s*:\\s*' +
    escaped + '(?=$|[\\s,;]|\\r|\\n)',
    'im'
  );
  return ZoteroApi_iterateLibrariesMatching(settings, function(row) {
    const extra = (row.data && row.data.extra) || '';
    return re.test(extra) ? (row.csljson || {}) : null;
  });
}

const ITERATE_PAGE_SIZE = 100;
const ITERATE_MAX_PER_LIBRARY = 2000;

/**
 * Walk every configured library, page by page, calling match(row) on each
 * item. The first row for which match returns a non-null value wins;
 * the function returns {csl, itemUri, key, library} for that item.
 *
 * Sorted by dateModified desc — most recently added/edited items first.
 */
function ZoteroApi_iterateLibrariesMatching(settings, matchFn) {
  const libs = ZoteroApi_libraries(settings);
  for (let li = 0; li < libs.length; li++) {
    const lib = libs[li];
    let start = 0;
    while (start < ITERATE_MAX_PER_LIBRARY) {
      const path = '/' + lib.type + '/' + encodeURIComponent(lib.id) +
                   '/items?format=json&include=csljson,data' +
                   '&itemType=-attachment' +
                   '&limit=' + ITERATE_PAGE_SIZE +
                   '&start=' + start +
                   '&sort=dateModified&direction=desc';
      let rows;
      try { rows = ZoteroApi_fetchJson(path, settings); }
      catch (e) { break; }
      if (!rows || !rows.length) break;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const matched = matchFn(row);
        if (matched) {
          return {
            key: row.key,
            csl: matched,
            data: row.data,
            itemUri: ZoteroApi_libUri(lib, row.key),
            title: (row.data && row.data.title) || matched.title || '(untitled)',
            library: lib
          };
        }
      }
      if (rows.length < ITERATE_PAGE_SIZE) break;
      start += ITERATE_PAGE_SIZE;
    }
  }
  return null;
}

/** Human-readable list of libraries we will search, for error messages. */
function ZoteroApi_describeLibraries(settings) {
  const libs = ZoteroApi_libraries(settings);
  if (!libs.length) return '(none — set Zotero user ID in Settings)';
  return libs.map(l => l.type + '/' + l.id).join(', ');
}

/** Probe each configured library with a 1-item fetch. Returns a per-library status. */
function ZoteroApi_probeLibraries(settings) {
  const out = [];
  ZoteroApi_libraries(settings).forEach(lib => {
    const path = '/' + lib.type + '/' + encodeURIComponent(lib.id) + '/items?limit=1&format=json';
    try {
      const r = ZoteroApi_fetchJson(path, settings);
      out.push({ lib: lib.type + '/' + lib.id, ok: true, sample: (r && r[0] && r[0].data && r[0].data.title) || '(empty library)' });
    } catch (e) {
      out.push({ lib: lib.type + '/' + lib.id, ok: false, error: String(e.message || e) });
    }
  });
  return out;
}

/** Dispatch DOI or PMID lookup. */
function ZoteroApi_findByDoiOrPmid(idObj, settings) {
  if (idObj.kind === 'doi') {
    return ZoteroApi_findByDoi(idObj.id, settings);
  }
  if (idObj.kind === 'pmid') {
    const doi = PubMed_pmidToDoi(idObj.id);
    if (!doi) return null;
    return ZoteroApi_findByDoi(doi, settings);
  }
  return null;
}
