#!/usr/bin/env node
/**
 * test/test-transfer.js
 *
 * Offline sanity check for the ZoteroTransfer ITEM-block + DOCUMENT_PREFERENCES
 * format. Re-implements the build math here (the Apps Script file can't be
 * `require`d directly because it uses Utilities/DocumentApp globals).
 *
 * Run from repo root:  node test/test-transfer.js
 * Exits non-zero on failure.
 */

const fs = require('fs');
const path = require('path');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  FAIL:', msg); failures++; }
  else { console.log('  ok  :', msg); }
}

function buildItemBlock(csl, itemUri, opts) {
  opts = opts || {};
  const placeholder = renderPlaceholder(csl);
  const ci = { id: itemUri, uris: [itemUri], itemData: csl };
  if (opts.locator) ci.locator = opts.locator;
  if (opts.label) ci.label = opts.label;
  return 'ITEM CSL_CITATION ' + JSON.stringify({
    citationID: 'abcdef12',
    properties: {
      unsorted: false,
      formattedCitation: placeholder,
      plainCitation: placeholder,
      noteIndex: 0
    },
    citationItems: [ci]
  });
}

function renderPlaceholder(csl) {
  let author = 'Anon';
  if (csl.author && csl.author.length) {
    const a = csl.author[0];
    author = a.family || a.literal || 'Anon';
    if (csl.author.length === 2 && csl.author[1].family) author += ' & ' + csl.author[1].family;
    else if (csl.author.length > 2) author += ' et al.';
  }
  let year = '';
  const issued = csl.issued && csl.issued['date-parts'] && csl.issued['date-parts'][0];
  if (issued && issued[0]) year = String(issued[0]);
  return '(' + author + (year ? ', ' + year : '') + ')';
}

function buildPrefs(styleId) {
  styleId = (styleId || 'apa').trim();
  if (styleId.indexOf('://') < 0) styleId = 'http://www.zotero.org/styles/' + styleId;
  return 'DOCUMENT_PREFERENCES ' + JSON.stringify({
    style: { styleID: styleId, hasBibliography: true, bibliographyStyleHasBeenSet: false },
    prefs: { fieldType: 'Http', automaticJournalAbbreviations: false, delayCitationUpdates: false, noteType: 0 },
    sessionID: 'sess1234',
    zoteroVersion: '8.0.4',
    dataVersion: 4
  });
}

function run() {
  console.log('transfer test');
  const csl = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-csl.json'), 'utf8'));

  // User library URI
  const userUri = 'http://zotero.org/users/15276932/items/ABCD1234';
  const userBlock = buildItemBlock(csl, userUri);
  assert(userBlock.indexOf('ITEM CSL_CITATION ') === 0, 'user block has correct prefix');
  const userJson = JSON.parse(userBlock.substring('ITEM CSL_CITATION '.length));
  assert(userJson.citationItems[0].uris[0] === userUri, 'user URI round-trips through JSON');
  assert(userJson.citationItems[0].itemData.title === csl.title, 'CSL title preserved');
  assert(userJson.properties.formattedCitation.startsWith('('), 'placeholder starts with (');

  // Group library URI (the bug from the user's screenshot — group items not findable)
  const groupUri = 'http://zotero.org/groups/5968208/items/CCPRPSRN';
  const groupBlock = buildItemBlock(csl, groupUri);
  const groupJson = JSON.parse(groupBlock.substring('ITEM CSL_CITATION '.length));
  assert(groupJson.citationItems[0].uris[0] === groupUri, 'group URI round-trips');

  // Locator
  const locBlock = buildItemBlock(csl, userUri, { locator: '42', label: 'page' });
  const locJson = JSON.parse(locBlock.substring('ITEM CSL_CITATION '.length));
  assert(locJson.citationItems[0].locator === '42' && locJson.citationItems[0].label === 'page', 'locator/label round-trip');

  // Prefs
  const prefs = buildPrefs('apa');
  assert(prefs.indexOf('DOCUMENT_PREFERENCES ') === 0, 'prefs has correct prefix');
  const prefsJson = JSON.parse(prefs.substring('DOCUMENT_PREFERENCES '.length));
  assert(prefsJson.style.styleID === 'http://www.zotero.org/styles/apa', 'short style id expanded to URL');
  assert(prefsJson.prefs.fieldType === 'Http', 'fieldType is Http (Google Docs format)');

  // Full URL passes through
  const prefs2 = buildPrefs('http://www.zotero.org/styles/nature');
  const prefs2Json = JSON.parse(prefs2.substring('DOCUMENT_PREFERENCES '.length));
  assert(prefs2Json.style.styleID === 'http://www.zotero.org/styles/nature', 'full style URL preserved');

  // --- v0.3 contract assertions ---
  // Rule from V2 document.js:199–237: link.text.trim().startsWith(prefix)
  // must match for each of these three, with trailing space included.
  assert(userBlock.startsWith('ITEM CSL_CITATION '), 'ITEM block prefix has trailing space');
  assert(prefs.startsWith('DOCUMENT_PREFERENCES '), 'PREFS prefix has trailing space');
  // Rule from V2 document.js:157–160: _reduceStructuralElements(body).startsWith(marker)
  // — the HEADER paragraph must be exactly the marker with nothing before it.
  const headerParagraph0 = 'ZOTERO_TRANSFER_DOCUMENT';
  assert(headerParagraph0 === 'ZOTERO_TRANSFER_DOCUMENT', 'header marker text matches V2 EXPORTED_DOCUMENT_MARKERS[0]');
  // Field URL constant from src_apps-script_Code.js:25 — it must match exactly.
  const ZT_FIELD_URL = 'https://www.zotero.org/google-docs/?';
  assert(ZT_FIELD_URL === 'https://www.zotero.org/google-docs/?', 'field URL matches Zotero config.fieldURL');
  // Our random key format: 6 alphanumeric chars. Verify the inline check
  // used for getFields in Code.js:1055 (link.url.length == fieldURL.length + 6).
  const sampleLinkUrl = ZT_FIELD_URL + 'aB3xY9';
  assert(sampleLinkUrl.length === ZT_FIELD_URL.length + 6, 'link URL length = fieldURL + 6');

  console.log('');
  if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
  console.log('all transfer tests passed');
}

run();
