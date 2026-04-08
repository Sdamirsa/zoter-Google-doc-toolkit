/**
 * Build / parse Zotero's on-document representation of a citation.
 *
 * Format (reverse-engineered from zotero/zotero-google-docs-integration):
 *   - Visible text wrapped in a hyperlink:
 *       https://www.zotero.org/google-docs/?<KEY6>
 *   - One or more NamedRanges covering the same text range, named:
 *       Z_F<KEY6><PART3><CHUNK>      (total <= 255 chars)
 *     Concatenating all chunks in PART order yields the field code:
 *       "ITEM CSL_CITATION " + JSON.stringify({...CSL citation...})
 *
 * On the user's next "Refresh" in the Zotero Connector, Zotero re-reads the
 * NamedRanges, resolves citationItems[].uris against the local library, and
 * rewrites both the text and the bibliography.
 *
 * We do NOT seed Z_D (document preferences). On first Refresh, Zotero will
 * prompt the user for a citation style — that is the safest default.
 */

const ZF_PREFIX = 'Z_F';
const ZF_KEY_LEN = 6;
const ZF_PART_LEN = 3;
// NamedRange name max is 255. Reserve prefix(3) + key(6) + part(3) = 12.
const ZF_CHUNK_MAX = 255 - 3 - ZF_KEY_LEN - ZF_PART_LEN;
const ZOTERO_LINK_BASE = 'https://www.zotero.org/google-docs/?';
const CSL_SCHEMA = 'https://github.com/citation-style-language/schemas/raw/master/csl-citation.json';

function ZoteroField_newKey() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < ZF_KEY_LEN; i++) {
    s += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return s;
}

function ZoteroField_pad(n) {
  let s = String(n);
  while (s.length < ZF_PART_LEN) s = '0' + s;
  return s;
}

/**
 * Build the field code string for a single citation.
 * cslItem: a CSL-JSON object (`data` from api.zotero.org csljson response).
 * itemUri: Zotero URI like http://zotero.org/users/<uid>/items/<itemKey>
 * locator/label/prefix/suffix optional.
 */
function ZoteroField_buildFieldCode(cslItem, itemUri, opts) {
  opts = opts || {};
  const citationID = Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  const plain = ZoteroField_renderPlaceholder(cslItem);
  const payload = {
    citationID: citationID,
    properties: {
      formattedCitation: plain,
      plainCitation: plain,
      noteIndex: 0
    },
    citationItems: [{
      id: cslItem.id || itemUri,
      uris: [itemUri],
      uri: [itemUri],
      itemData: cslItem,
      label: opts.label || undefined,
      locator: opts.locator || undefined,
      prefix: opts.prefix || undefined,
      suffix: opts.suffix || undefined
    }],
    schema: CSL_SCHEMA
  };
  // strip undefineds in citationItems[0]
  const ci = payload.citationItems[0];
  Object.keys(ci).forEach(k => ci[k] === undefined && delete ci[k]);
  return 'ITEM CSL_CITATION ' + JSON.stringify(payload);
}

/**
 * Render a quick "(Author Year)" placeholder from CSL-JSON.
 * Zotero overwrites this on next Refresh, so it just needs to be readable.
 */
function ZoteroField_renderPlaceholder(csl) {
  let author = 'Anon';
  if (csl.author && csl.author.length) {
    const a = csl.author[0];
    author = a.family || a.literal || 'Anon';
    if (csl.author.length === 2 && csl.author[1].family) {
      author += ' & ' + csl.author[1].family;
    } else if (csl.author.length > 2) {
      author += ' et al.';
    }
  }
  let year = '';
  const issued = csl.issued && csl.issued['date-parts'] && csl.issued['date-parts'][0];
  if (issued && issued[0]) year = String(issued[0]);
  return '(' + author + (year ? ', ' + year : '') + ')';
}

/**
 * Insert a Zotero-format citation in place of an existing Text element range.
 * Replaces text [startOffset..endOffsetInclusive] inside `textElement` with
 * the placeholder, links it, and creates the chunked Z_F NamedRanges.
 *
 * Returns the new key.
 */
function ZoteroField_insertAt(textElement, startOffset, endOffsetInclusive, fieldCode, displayText) {
  const doc = DocumentApp.getActiveDocument();
  // Replace text
  const original = textElement.getText();
  const before = original.substring(0, startOffset);
  const after = original.substring(endOffsetInclusive + 1);
  textElement.setText(before + displayText + after);

  const newStart = before.length;
  const newEnd = newStart + displayText.length - 1;

  // Hyperlink
  const key = ZoteroField_newKey();
  textElement.setLinkUrl(newStart, newEnd, ZOTERO_LINK_BASE + key);

  // Build a Range covering exactly the inserted text and create NamedRanges
  const rb = doc.newRange();
  rb.addElement(textElement, newStart, newEnd);
  const range = rb.build();

  // Chunk the field code
  const chunks = [];
  for (let i = 0; i < fieldCode.length; i += ZF_CHUNK_MAX) {
    chunks.push(fieldCode.substring(i, i + ZF_CHUNK_MAX));
  }
  for (let i = 0; i < chunks.length; i++) {
    const name = ZF_PREFIX + key + ZoteroField_pad(i) + chunks[i];
    doc.addNamedRange(name, range);
  }
  return key;
}

/**
 * List existing Zotero fields in the document (for the Scan UI).
 */
function ZoteroField_listExisting() {
  const doc = DocumentApp.getActiveDocument();
  const ranges = doc.getNamedRanges();
  const byKey = {};
  ranges.forEach(nr => {
    const name = nr.getName();
    if (name.indexOf(ZF_PREFIX) !== 0) return;
    const key = name.substr(3, ZF_KEY_LEN);
    byKey[key] = byKey[key] || 0;
    byKey[key]++;
  });
  return Object.keys(byKey).map(k => ({ key: k, parts: byKey[k] }));
}
