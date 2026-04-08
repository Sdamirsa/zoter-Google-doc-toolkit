# Zotero Google Docs Integration — Internal Reference

> Compiled from a deep read of the official Zotero sources. Source files are
> archived for reference under `.claude/zg-investigation/` in this repo
> (downloaded from `zotero/zotero`, `zotero/zotero-connectors`, and
> `zotero/zotero-google-docs-integration`).
>
> This document is the canonical internal reference for how Zotero recognizes
> and processes Google Docs citations. Read it before modifying anything in
> `src/ZoteroTransfer.js`, `src/Resolver.js`, or `src/Find.js`.

## 1. Architecture — three codebases

Zotero's Google Docs integration is NOT a Google Docs add-on. It is three
codebases cooperating:

1. **In-page content script** — injected by the Zotero Connector browser
   extension into `docs.google.com/document/*`. Adds the Zotero menu, reads
   and writes the document via the Google Docs API. Files of interest (in
   `.claude/zg-investigation/`):
   - `src_connector_googleDocs.js` — bootstrap + V2/legacy client switch
   - `src_connector_ui.jsx` — menu items including "Refresh" and "Switch word processors..."
   - `src_connector_document.js` — V2 document wrapper (the current default)
   - `src_connector_clientAppsScript.js` — legacy client (fallback)
   - `src_connector_api.js` — OAuth + `batchUpdate` + `scripts.run`

2. **Zotero desktop** — the Firefox/XULRunner app running on the user's
   machine. Owns citeproc and all business logic for refresh/insert/import.
   Listens on `http://127.0.0.1:23119/connector/document/execCommand`.
   - `zotero_integration.js` — `Zotero.Integration.*` dispatchers, `getSession`,
     `session.importDocument`, `session.refresh`

3. **A Google Apps Script executable** deployed by Zotero at script ID
   `AKfycbzCBCyrm1hnQJDEckGkOJabbhv4SO7udII0SK5BoKbgJLxy5I6A5LiGZ_xAZ-eOYEIJuw`
   (from `zotero-connectors/src/common/zotero_config.js`). Only used by the
   legacy `ClientAppsScript`. Third parties cannot invoke it — it is locked
   to Zotero's own OAuth client.
   - `src_apps-script_Code.js` — the entire deployed script

**Client selection:** `googleDocs.js:84–106`. V2 is the default; the legacy
Apps Script path is a fallback chosen by a preference or a remote flag.
Assume V2 on any recent Connector.

## 2. What "Refresh" actually does (V2 client)

Call path:

1. User clicks the "Refresh" menu item → `ui.jsx:1165`:
   ```
   <Menu.Item label="Refresh" shortcutKey='r' activate={this.props.execCommand.bind(this, 'refresh', null)} />
   ```
2. `Zotero.GoogleDocs.execCommand('refresh')` → dispatches a
   `Zotero.Integration.execCommand` DOM event.
3. `connectorIntegration.js:34–52` catches it and POSTs to
   `http://127.0.0.1:23119/connector/document/execCommand` with
   `{command: 'refresh', docId}`.
4. Zotero desktop runs `Zotero.Integration.execCommand` at
   `zotero_integration.js:247`.
5. Calls `getSession(app, doc, agent, 'refresh')` at line 281 → `getSession`
   at `zotero_integration.js:522–600`.
6. **Critical branch**: `dataString = await doc.getDocumentData()` at line 533.
   If `dataString === "ZOTERO_TRANSFER_DOCUMENT"`, the import flow runs
   (line 588 → `session.importDocument`). Otherwise the normal refresh flow
   runs (line 919 `Interface.refresh`).

Normal refresh calls `session.updateFromDocument(FORCE_CITATIONS_REGENERATE)`
→ `updateDocument(...)` → loops over `getFields`, reads each field's `code`,
re-runs citeproc, writes the new text via `setText`/`setCode` → becomes a
Google Docs `batchUpdate` with `insertText`/`deleteContentRange`/
`updateTextStyle`/`createNamedRange`/`deleteNamedRange`.

## 3. The `Z_F / Z_D / Z_B` NamedRange format

From `src_apps-script_Code.js:25–43`:

```
fieldURL:       'https://www.zotero.org/google-docs/?'
brokenFieldURL: 'https://www.zotero.org/google-docs/?broken='
fieldKeyLength: 6
citationPlaceholder: "{Updating}"
fieldPrefix:    "Z_F"  // citation fields
dataPrefix:     "Z_D"  // document-wide preferences
biblStylePrefix:"Z_B"  // bibliography paragraph style
```

### NamedRange name encoding

`encodeRange` at `Code.js:213–230`:

```
while (code.length) {
    var str = prefix + (i < 10 ? '00' : i < 100 ? '0' : '') + i;
    str += code.substr(0, 255 - prefix.length - 3);
    code = code.substr(255 - prefix.length - 3);
    codes.push(str);
    i++;
}
```

So a NamedRange name is:

```
<prefix><3-digit-zero-padded-index><payload chunk>
```

- For fields: `prefix = "Z_F" + <6-char-id>`, so names look like
  `Z_FAbCd3E000<payload>`. The 6-char id is both embedded in the NamedRange
  name AND in the hyperlink URL (see §4).
- For doc data: `prefix = "Z_D"`, names look like `Z_D000<payload>`.
- For bib style: `prefix = "Z_B"`.
- Google caps NamedRange names at 255 characters, so each chunk holds at
  most `255 - prefix.length - 3` payload characters. With a `Z_F<key>` prefix
  (9 chars), that's 243 chars per chunk.
- The 3-digit zero-padded index caps total chunks at 1000 per field.
- `decodeRanges` (`Code.js:232–255`) sorts chunks by name and asserts
  contiguous index starting at `000`. Any gap → `throw new Error("Ranges corrupt on ...")`
  and the ranges are queued for deletion.

### Why this matters to us

**We are NOT writing NamedRanges.** The v0.1 approach of pre-populating
`Z_F` NamedRanges failed — Zotero's `getFields` requires a matching
hyperlink (§4), correctly-chunked payload starting at index 000, and the
field key embedded in both the NamedRange name and the hyperlink URL. One
thing off, the whole field is rejected or deleted as orphaned.

## 4. Hyperlink role — `https://www.zotero.org/google-docs/?<KEY>`

The NamedRange carries the code, but **the hyperlink is "the field"**.
`getFields` scans the document's hyperlinks and filters via:

```js
// Code.js:1051–1057, document.js:985–990
return link.url.indexOf(config.fieldURL) == 0
    && link.url.length == config.fieldURL.length + config.fieldKeyLength;
```

So the URL must be exactly `https://www.zotero.org/google-docs/?` plus a
6-character key. Any other URL (different prefix, extra path, different key
length) is ignored by the field scanner.

A hyperlink with the field URL but no matching NamedRange:

- If the visible text is exactly `{Updating}` → treated as a placeholder
  for a new field (`Code.js:153–162`, `document.js:345–347`).
- Otherwise → treated as an **orphaned citation**: URL rewritten to
  `?broken=<key>`, text turned red (`Code.js:262–295`).

A NamedRange with no matching hyperlink → deleted as orphaned.

## 5. The `ZOTERO_TRANSFER_DOCUMENT` format (what we actually rely on)

This is the only path a third-party script can use without reverse-engineering.
It is both an export format and an import format. Zotero exports to it via
"Switch word processors...", and recognizes it on import via any Zotero
command (Refresh, Add Citation, etc.).

### Export (what Zotero writes)

`src_apps-script_Code.js:611–631`:

```js
exposed.exportDocument = function(_, importInstructions) {
    // Convert every existing field to visible ITEM CSL_CITATION text
    var fields = getFields();
    for (var i = fields.length-1; i >= 0; i--) {
        var field = fields[i];
        field.write({text: field.code}, true);
    }
    var body = doc.getBody();
    // Append DOCUMENT_PREFERENCES paragraph, hyperlinked
    var docData = exposed.getDocumentData();
    if (docData) {
        var para = body.appendParagraph("DOCUMENT_PREFERENCES " + docData);
        para.setLinkUrl(config.fieldURL);
    }
    // Insert 4-paragraph header: marker, blank, instructions, blank
    body.insertParagraph(0, EXPORTED_DOCUMENT_MARKERS[0]);
    body.insertParagraph(1, " ");
    body.insertParagraph(2, importInstructions);
    body.insertParagraph(3, " ");
}
```

V2's equivalent at `src_connector_document.js:162–197` is identical in shape.
After export, all `Z_F` / `Z_D` / `Z_B` NamedRanges are deleted — the
document's entire state lives in text content and hyperlinks.

### Import (what Zotero reads on Refresh)

**Marker detection** is the critical gatekeeper. V2 at
`src_connector_document.js:157–160`:

```js
isExportedDocument() {
    let text = this._reduceStructuralElements(this.body.content);
    return EXPORTED_DOCUMENT_MARKERS.some(marker => text.startsWith(marker));
}
```

- The entire body is concatenated into one string.
- `startsWith` — the marker must be the **very first characters of the body**.
- Any title, heading, blank line, or whitespace before the marker → detection
  fails → import flow never runs.

(The Apps Script version at `Code.js:257–260` is more lenient:
`doc.getBody().getParagraphs()[0].findText(marker)` — finds the marker
anywhere in the first paragraph. But we can't rely on this because users
run V2.)

**Import logic** at `src_connector_document.js:199–237`:

```js
async importDocument() {
    let importField = (link, text) => {
        let key = Zotero.Utilities.randomString(config.fieldKeyLength);
        var field = new Field(this, link, key, [], config.fieldPrefix);
        field.setText('{Imported field}');
        field.setCode(text);
        field.write(false, true);
    }
    let dataImported = false;
    const importTypes = {
        "ITEM CSL_CITATION ": importField,
        "BIBL ":              importField,
        "DOCUMENT_PREFERENCES ": (link, text) => {
            dataImported = true;
            this.setDocumentData(text.substr("DOCUMENT_PREFERENCES ".length));
            this.addBatchedUpdate('deleteContentRange', { range: Utilities.getRangeFromLinks(link) });
        },
    };
    let links = this.getLinks();  // HYPERLINKS ONLY
    for (var i = links.length-1; i >= 0; i--) {
        let link = links[i];
        let text = link.text.trim();
        for (let key in importTypes) {
            if (text.startsWith(key)) {
                importTypes[key](link, text);
            }
        }
    }
    // Delete first 4 paragraphs (marker, blank, instructions, blank)
    let text = this._reduceStructuralElements(this.body.content);
    let headerText = text.split('\n').slice(0, 4).join('\n');
    this.addBatchedUpdate('deleteContentRange', { range: {
        startIndex: 1,
        endIndex: 2 + headerText.length
    } });
    if (dataImported) {
        await this.commitBatchedUpdates();
    }
    return dataImported;
}
```

Four rules fall out of this:

1. **V2 only sees hyperlinks.** `getLinks()` returns hyperlink spans. Plain
   text with `ITEM CSL_CITATION ...` is invisible to this scanner. THIS IS
   WHAT BROKE v0.2.
2. **Link text matching is `trim().startsWith(prefix)`.** The hyperlinked
   span must start with the literal prefix + trailing space.
3. **`DOCUMENT_PREFERENCES ` is mandatory.** Without it, `dataImported`
   stays false, V2 returns false, and the session shows
   `"No importable data found"` (`zotero_integration.js:2130–2132`).
4. **Exactly 4 leading paragraphs** are deleted after import
   (`[marker, " ", instructions, " "]`). If our header layout differs, the
   delete range is wrong.

### The native confirm dialog

At `zotero_integration.js:2108–2124`, before `importDocument` runs:

```js
var result = ps.confirmEx(null,
    Zotero.getString('integration.importDocument.title'),
    Zotero.getString('integration.importDocument.description',
        [Zotero.clientName, this._app.processorName]),
    buttonFlags,
    Zotero.getString('integration.importDocument.button'),  // Continue
    null,                                                    // Cancel
    Zotero.getString('general.moreInformation'),             // More Info
    null, {});
if (result == 1) throw new Zotero.Exception.UserCancelled("the document import");
if (result == 2) { Zotero.launchURL(documentationURL); throw ... }
```

**We cannot suppress this dialog.** The user will always see "Zotero needs to
convert this document. Continue?" on the first Refresh after our Resolve.

## 6. What we CAN and CANNOT do

| | Status |
|---|---|
| Invoke Zotero's Apps Script executable | ❌ Locked to Zotero's OAuth client |
| Trigger `session.importDocument` directly | ❌ Only from `getSession` via marker |
| Suppress the native confirm dialog | ❌ `ps.confirmEx` runs on Zotero desktop |
| Write `Z_F` NamedRanges Zotero will accept | ⚠️ Theoretically yes; practically fragile across apiVersion bumps |
| Write a `ZOTERO_TRANSFER_DOCUMENT` layout Zotero imports | ✅ **This is our chosen path** |
| Pre-populate bibliography | ❌ Not needed; Zotero regenerates it post-import |

## 7. The three hard rules our code must obey

1. **`_reduceStructuralElements(body) starts with "ZOTERO_TRANSFER_DOCUMENT"`.**
   Our Resolve unconditionally inserts 4 header paragraphs at body index 0.
   No user content can sit above them.

2. **Every `ITEM CSL_CITATION ...` / `BIBL ...` / `DOCUMENT_PREFERENCES ...`
   span is hyperlinked.** The URL is
   `https://www.zotero.org/google-docs/?` optionally followed by a 6-char
   key. Plain text is invisible to V2.

3. **A `DOCUMENT_PREFERENCES ` hyperlinked paragraph is appended**, or
   V2 returns `dataImported=false` and we get the "No importable data found"
   alert.

## 8. Quick reference — key file:line citations

| Subject | File | Lines |
|---|---|---|
| `config` constants | `.claude/zg-investigation/src_apps-script_Code.js` | 25–43 |
| `checkForExportMarker` (AppsScript) | `src_apps-script_Code.js` | 257–260 |
| `exposed.exportDocument` (canonical template) | `src_apps-script_Code.js` | 611–631 |
| `exposed.importDocument` | `src_apps-script_Code.js` | 633–675 |
| `isExportedDocument` (V2 — strict) | `src_connector_document.js` | 157–160 |
| V2 `exportDocument` | `src_connector_document.js` | 162–197 |
| V2 `importDocument` | `src_connector_document.js` | 199–237 |
| `getSession` + transfer branch | `zotero_integration.js` | 522–600 |
| `session.importDocument` + `ps.confirmEx` | `zotero_integration.js` | 2094–2148 |
| `execCommand` refresh dispatch | `src_connector_googleDocs.js` | 108–131 |

## 9. Further reading

- https://github.com/zotero/zotero-google-docs-integration — main repo
- https://github.com/zotero/zotero-google-docs-integration/issues/1 — the issue that added the transfer-document machinery
- https://github.com/zotero/zotero-google-docs-integration/issues/71 — maintainer position on the transfer procedure
- https://www.zotero.org/support/kb/moving_documents_between_word_processors — user-facing doc for the format
