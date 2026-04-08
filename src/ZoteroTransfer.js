/**
 * Zotero Transfer Document format (v0.3 — V2-compatible).
 *
 * Zotero's "transfer document" format is the only officially-supported path
 * for a third-party script to pre-populate citations that Zotero will ingest
 * on Refresh. It is the same format Zotero's "Switch Word Processors..."
 * command produces. See docs/ZOTERO_INTEGRATION_INTERNALS.md for full details.
 *
 * THE THREE HARD RULES (from V2 `document.js:157–237`):
 *
 * 1. The body must START with "ZOTERO_TRANSFER_DOCUMENT" (V2 uses startsWith
 *    on the flattened body text). Our ensureMarkers() inserts 4 paragraphs
 *    at body index 0: [marker, " ", instructions, " "] — matching Zotero's
 *    own exportDocument (Code.js:627–630) exactly.
 *
 * 2. Every "ITEM CSL_CITATION ", "BIBL ", and "DOCUMENT_PREFERENCES " span
 *    must be a HYPERLINK. V2 scans getLinks(), not plain text — an ITEM
 *    block that isn't hyperlinked is invisible to the importer. This was
 *    the silent failure mode of v0.2. The URL is
 *    `https://www.zotero.org/google-docs/?` optionally followed by a 6-char
 *    key (Zotero uses no key for DOCUMENT_PREFERENCES, random key for items).
 *
 * 3. A DOCUMENT_PREFERENCES link MUST exist, or V2 returns dataImported=false
 *    and the desktop shows "No importable data found". See integration.js:
 *    2130–2132.
 *
 * After the user clicks Zotero → Refresh, a native "Zotero needs to convert
 * this document. Continue?" dialog appears (integration.js:2108–2124). This
 * dialog is unavoidable — we cannot suppress it. After the user clicks
 * Continue, Zotero replaces our ITEM blocks with proper fields, adds a
 * bibliography, and removes the 4 header paragraphs and the DOCUMENT_PREFERENCES
 * paragraph.
 */

const ZT_HEADER = 'ZOTERO_TRANSFER_DOCUMENT';
const ZT_DESC =
  'The Zotero citations in this document have been converted to a format ' +
  'that can be safely transferred between word processors. Open this ' +
  'document in a supported word processor and press Refresh in the Zotero ' +
  'plugin to continue working with the citations.';
const ZT_PREFS_PREFIX = 'DOCUMENT_PREFERENCES ';
const ZT_ITEM_PREFIX = 'ITEM CSL_CITATION ';
const ZT_FIELD_URL = 'https://www.zotero.org/google-docs/?';

/** 6-character alphanumeric random key, same format as Zotero's own field keys. */
function ZoteroTransfer_newLinkKey() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) {
    s += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return s;
}

/**
 * Build the inline ITEM CSL_CITATION block for one citation.
 * cslItem: CSL-JSON object (the `csljson` field returned by api.zotero.org)
 * itemUri: Zotero URI, e.g.
 *           http://zotero.org/users/<uid>/items/<key>
 *           http://zotero.org/groups/<gid>/items/<key>
 * opts:    { locator, label, prefix, suffix } — all optional
 */
function ZoteroTransfer_buildItemBlock(cslItem, itemUri, opts) {
  opts = opts || {};
  const placeholder = ZoteroTransfer_renderPlaceholder(cslItem);
  const ci = {
    id: itemUri,
    uris: [itemUri],
    itemData: cslItem
  };
  if (opts.locator) ci.locator = opts.locator;
  if (opts.label) ci.label = opts.label;
  if (opts.prefix) ci.prefix = opts.prefix;
  if (opts.suffix) ci.suffix = opts.suffix;

  const payload = {
    citationID: Utilities.getUuid().replace(/-/g, '').slice(0, 8),
    properties: {
      unsorted: false,
      formattedCitation: placeholder,
      plainCitation: placeholder,
      noteIndex: 0
    },
    citationItems: [ci]
  };
  return ZT_ITEM_PREFIX + JSON.stringify(payload);
}

/** "(Smith 2020)" placeholder text — Zotero overwrites this on Refresh. */
function ZoteroTransfer_renderPlaceholder(csl) {
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

/** Build the DOCUMENT_PREFERENCES line. */
function ZoteroTransfer_buildPrefs(styleId) {
  styleId = (styleId || 'apa').trim();
  if (styleId.indexOf('://') < 0) {
    styleId = 'http://www.zotero.org/styles/' + styleId;
  }
  const prefs = {
    style: {
      styleID: styleId,
      hasBibliography: true,
      bibliographyStyleHasBeenSet: false
    },
    prefs: {
      fieldType: 'Http',
      automaticJournalAbbreviations: false,
      delayCitationUpdates: false,
      noteType: 0
    },
    sessionID: Utilities.getUuid().replace(/-/g, '').slice(0, 8),
    zoteroVersion: '8.0.4',
    dataVersion: 4
  };
  return ZT_PREFS_PREFIX + JSON.stringify(prefs);
}

/**
 * Replace a [@zotero:...] tag in `textElement[start..endInclusive]` with the
 * inline ITEM block, AND hyperlink the inserted span so V2's getLinks()
 * scanner can find it on Refresh.
 *
 * This is rule #2 — without the setLinkUrl call, the ITEM block is invisible
 * to Zotero's importer and Refresh silently does nothing.
 */
function ZoteroTransfer_insertAt(textElement, startOffset, endOffsetInclusive, itemBlock) {
  const original = textElement.getText();
  const before = original.substring(0, startOffset);
  const after = original.substring(endOffsetInclusive + 1);
  textElement.setText(before + itemBlock + after);

  // Hyperlink the inserted span — required for V2's getLinks()-based importer.
  const linkStart = before.length;
  const linkEnd = linkStart + itemBlock.length - 1;
  const key = ZoteroTransfer_newLinkKey();
  textElement.setLinkUrl(linkStart, linkEnd, ZT_FIELD_URL + key);
}

/**
 * Make sure the document has the ZOTERO_TRANSFER_DOCUMENT header at the top
 * AND a hyperlinked DOCUMENT_PREFERENCES line at the bottom. Idempotent.
 *
 * Header layout matches Zotero's own exportDocument (Code.js:627–630):
 *   paragraph 0: "ZOTERO_TRANSFER_DOCUMENT"
 *   paragraph 1: " " (single space, NOT empty)
 *   paragraph 2: importInstructions
 *   paragraph 3: " " (single space, NOT empty)
 *
 * The DOCUMENT_PREFERENCES paragraph is hyperlinked over its entire length —
 * without this link, V2 returns dataImported=false and the desktop shows
 * "No importable data found" (rule #3).
 */
function ZoteroTransfer_ensureMarkers(styleId) {
  const doc = DocumentApp.getActiveDocument();
  const body = doc.getBody();

  // --- Header check & insert ---
  // V2 uses startsWith on the flattened body text, so paragraph 0 MUST be
  // exactly "ZOTERO_TRANSFER_DOCUMENT".
  let hasHeader = false;
  if (body.getNumChildren() > 0) {
    const first = body.getChild(0);
    if (first.getType() === DocumentApp.ElementType.PARAGRAPH) {
      const t = first.asParagraph().getText();
      if (t.indexOf(ZT_HEADER) === 0) hasHeader = true;
    }
  }
  if (!hasHeader) {
    // Insert in ascending index order — each insert pushes later indices down.
    // Resulting order: [ZT_HEADER, " ", ZT_DESC, " ", ...original]
    body.insertParagraph(0, ZT_HEADER);
    body.insertParagraph(1, ' ');
    body.insertParagraph(2, ZT_DESC);
    body.insertParagraph(3, ' ');
  }

  // --- Footer check & insert ---
  let hasFooter = false;
  const n = body.getNumChildren();
  for (let i = 0; i < n; i++) {
    const c = body.getChild(i);
    if (c.getType() === DocumentApp.ElementType.PARAGRAPH) {
      const t = c.asParagraph().getText();
      if (t.indexOf(ZT_PREFS_PREFIX) === 0) { hasFooter = true; break; }
    }
  }
  if (!hasFooter) {
    const prefsText = ZoteroTransfer_buildPrefs(styleId);
    const para = body.appendParagraph(prefsText);
    // Hyperlink the entire paragraph text. Required — V2 only sees linked text.
    const textEl = para.editAsText();
    const len = textEl.getText().length;
    if (len > 0) {
      textEl.setLinkUrl(0, len - 1, ZT_FIELD_URL);
    }
  }
}

/** Count inline ITEM blocks in the document — used by the Scan UI. */
function ZoteroTransfer_countItemBlocks() {
  const doc = DocumentApp.getActiveDocument();
  const body = doc.getBody();
  const text = body.getText();
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(ZT_ITEM_PREFIX, idx)) !== -1) {
    count++;
    idx += ZT_ITEM_PREFIX.length;
  }
  return count;
}
