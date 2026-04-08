/**
 * Thin client for api.zotero.org (Web API v3).
 * All calls require user ID + API key from Settings.
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

/** Fetch a single item by Zotero key. Returns {csl, itemUri}. */
function ZoteroApi_getItemByKey(key, settings) {
  const path = '/users/' + encodeURIComponent(settings.zoteroUserId) +
               '/items/' + encodeURIComponent(key) +
               '?format=json&include=csljson,data';
  const r = ZoteroApi_fetchJson(path, settings);
  if (!r || !r.csljson) throw new Error('Item ' + key + ' has no CSL-JSON');
  return {
    csl: r.csljson,
    itemUri: 'http://zotero.org/users/' + settings.zoteroUserId + '/items/' + key
  };
}

/** Search the user's library. Returns array of {key, csl, itemUri, title}. */
function ZoteroApi_search(query, settings, limit) {
  limit = limit || 5;
  const path = '/users/' + encodeURIComponent(settings.zoteroUserId) +
               '/items?q=' + encodeURIComponent(query) +
               '&qmode=everything&limit=' + limit +
               '&format=json&include=csljson,data';
  const r = ZoteroApi_fetchJson(path, settings);
  return (r || []).map(row => ({
    key: row.key,
    csl: row.csljson,
    itemUri: 'http://zotero.org/users/' + settings.zoteroUserId + '/items/' + row.key,
    title: (row.data && row.data.title) || (row.csljson && row.csljson.title) || '(untitled)'
  }));
}

/** Try to find a library item by DOI. */
function ZoteroApi_findByDoi(doi, settings) {
  const hits = ZoteroApi_search(doi, settings, 5);
  const norm = String(doi).toLowerCase();
  return hits.find(h => {
    const d = (h.csl && h.csl.DOI) || '';
    return String(d).toLowerCase() === norm;
  }) || null;
}
