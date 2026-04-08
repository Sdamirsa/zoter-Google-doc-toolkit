# Installation Guide

Install **Zoter Toolkit** as a Google Apps Script add-on for your own Google account in about 10 minutes. **No command line, no Node, no `clasp` required.**

## What you'll need

- A Google account (the one you write papers with)
- A [Zotero](https://www.zotero.org/) account with a [Web API key](https://www.zotero.org/settings/keys) — read-only is fine
- The Zotero **desktop app** + the **[Zotero Connector](https://www.zotero.org/download/)** browser extension (used for the final "Refresh" step)
- *(Optional, only for `[@zotero:find]`)* An **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com/)

## Safety model

The script is installed once into a single Apps Script project on **your** Google account. It uses the `documents.currentonly` OAuth scope, which means it can **only** read or write the Google Doc that is currently open in front of you. It cannot enumerate, list, or touch any of your other docs. Your Zotero and Anthropic API keys are stored in `PropertiesService.getUserProperties()` — per-user, per-script storage that no other doc or user can read.

---

## Step 1 — Create the Apps Script project

1. Open https://script.google.com
2. Click **+ New project**
3. Top-left, rename **"Untitled project"** to **`Zoter Toolkit`**

You'll now see an editor with a single default `Code.gs` file.

## Step 2 — Paste the source files

Open [`dist/INSTALL_PASTE.md`](dist/INSTALL_PASTE.md) in another tab. It contains one block per source file with paste instructions.

For each block in `INSTALL_PASTE.md`:

- **Script files** (`Code.gs`, `ZoteroField.gs`, etc.): in the editor, click the **+** next to "Files" → **Script** → name it (no extension) → delete any default content → paste. The default `Code.gs` already exists; just open it and replace its contents.
- **HTML files** (`Sidebar.html`, `Settings.html`): **+** → **HTML** → name it → paste.
- **Manifest** (`appsscript.json`): click the **gear icon** (Project Settings) on the left sidebar → check **"Show appsscript.json manifest file in editor"** → return to the Editor → open `appsscript.json` → replace contents with the block.

Click the **disk icon** (Save) when you're done. The editor will save all files at once.

## Step 3 — Install as an Editor add-on

1. In the script editor, click **Deploy → Test deployments**.
2. Under **Select type**, click the **gear icon ⚙ → Editor Add-on**.
3. In the **Config** dropdown, choose **"Installed for current user"**. This is the option that makes the add-on appear in every Doc on your account (the other options scope it to a single doc).
4. **You must also pick a Test document** — even with "Installed for current user", the **Save test** button stays disabled until a test doc is selected. Click the upload icon in the **Test document** field and pick any Google Doc you own. (It's only used to scope the *test session*; once installed, the add-on is active in every Doc on your account regardless of which one you picked here.)
5. Click **Save test** → **Done**.

That's it. The add-on is now active in **every Google Doc on this account**, present and future. You don't need to repeat this for new docs.

## Step 4 — First-doc test

1. Open any Google Doc (or create a new one)
2. Look for **Extensions → Zoter Toolkit → Open sidebar** in the menu bar
   - If you don't see it, reload the doc tab
3. Click **Open sidebar**
4. Click **Open settings…** in the sidebar
5. Paste your **Zotero user ID**, **Zotero API key**, and *(optional)* **Anthropic API key** → **Save**
6. Click **Test Claude connection** to verify the Anthropic key works (only if you set one)

## Step 5 — Resolve a citation (v0.1)

1. In the doc, type:

   ```
   The original report [@zotero:ABCD1234] showed...
   ```

   Replace `ABCD1234` with a real 8-character item key from your Zotero library. Find it in the Zotero desktop app: right-click an item → **Show in Library**, then look at the item key in the Info pane (or in the URL of your web library at zotero.org/mylibrary).
2. In the sidebar, click **Resolve all [@zotero:...]**. The tag is replaced with placeholder text like `(Smith, 2020)`, hyperlinked, with hidden Zotero metadata attached.
3. Click **Zotero → Refresh** in the Zotero Connector toolbar (in the Google Docs toolbar area). The first time, Zotero will ask you to pick a citation style — pick whatever you want; it remembers per-doc.
4. The placeholder is replaced with a properly formatted citation, and a bibliography appears at the end of the doc.

## Step 6 — Find new citations (v0.2)

1. Write a sentence with a scientific claim and append `[@zotero:find]`:

   ```
   CRISPR-Cas9 efficiency drops sharply in non-dividing cells [@zotero:find].
   ```
2. In the sidebar, click **Find candidates for [@zotero:find]**. Claude searches the web (10–30 s per tag) and returns up to 3 candidate papers per tag, each tagged as **supports**, **contradicts**, or **related**, with a one-sentence justification.
3. Each candidate shows whether it's already in your Zotero library:

   - **in library** → click **Insert** to convert the tag into a Zotero field, then **Zotero → Refresh**
   - **save first** → save the paper in Zotero (Connector → Save), then click **Find candidates** again to refresh status

### Find tag variants


| Tag                         | Effect                                |
| ----------------------------- | --------------------------------------- |
| `[@zotero:find]`            | Mixed: supports, contradicts, related |
| `[@zotero:find?support]`    | Only supporting evidence              |
| `[@zotero:find?contradict]` | Only contradicting/questioning        |
| `[@zotero:find?n=5]`        | Up to 5 candidates instead of 3       |

---

## Tag syntax cheat sheet


| Tag                             | What it does                                  |
| --------------------------------- | ----------------------------------------------- |
| `[@zotero:ABCD1234]`            | 8-char Zotero item key (most reliable)        |
| `[@zotero:10.1038/nature12373]` | DOI — must already be in your Zotero library |
| `[@zotero:pmid:29028643]`       | PubMed ID → DOI → library lookup            |
| `[@zotero:?crispr cas9 2020]`   | Free-text Zotero library search (top hit)     |
| `[@zotero:find]`                | LLM-assisted discovery (v0.2)                 |
| `[@zotero:ABCD1234|p. 42]`      | Add a page locator (use`|`, not `,`)          |

---

## Updating the add-on

When new code lands:

1. Pull or open the latest `dist/INSTALL_PASTE.md` from the repo
2. In the Apps Script editor, open each changed file and replace its contents with the new block
3. Save

All Google Docs immediately use the new version on next open. There's no per-doc reinstall.

---

## Troubleshooting

**Menu doesn't appear** — Reload the Doc tab. If still missing, verify Test Deployment install (Step 3) succeeded; in the Apps Script editor: **Deploy → Test deployments → Install**.

**`Cannot call DocumentApp.getUi() from this context`** when running `onOpen` from the editor — Expected. `onOpen` only fires when a real Doc opens. Don't run it from the editor; install via Test Deployments and open a Doc.

**"Item not found in your library"** for DOI/PMID/find — The item must already be saved in Zotero. Save it via the Zotero Connector first. If the item lives in a **group library**, also: (a) add the numeric group ID to **Settings → Zotero group IDs** (find it in the URL at zotero.org/groups/<id>/<name>), and (b) make sure your Zotero API key was created with **read access to that group** at https://www.zotero.org/settings/keys (the group permissions are a separate set of checkboxes during key creation — read-only on your personal library does NOT include groups by default).

**To debug** which libraries are actually reachable, click **Diagnose Zotero connection** in the sidebar. It probes each configured library with a 1-item fetch and reports per-library success/failure. If a group shows ✗ with a 403, your API key isn't authorized for that group — go regenerate the key with the right permissions.

---

### Refresh-related issues (the "Resolve worked but Refresh does nothing" class)

**Refresh does nothing visible, no dialog appears** — The `ZOTERO_TRANSFER_DOCUMENT` marker must be the very first characters of the document body. If there is a title, heading, or any text above it, Zotero's V2 connector silently ignores the doc. Check that the first paragraph of your doc is exactly `ZOTERO_TRANSFER_DOCUMENT` on its own line — no title, no "My Paper" heading, no blank line before it. If you need a title, add it only AFTER the first Refresh converts the doc to normal Zotero format.

**You see the "Zotero needs to convert this document" dialog, but after clicking Continue you get "No importable data found"** — The `ITEM CSL_CITATION ...` spans or the `DOCUMENT_PREFERENCES ...` paragraph are not hyperlinked. Zotero V2 only scans hyperlinks — plain text with the right prefix is invisible to it. After clicking Resolve in the sidebar, hover over the long `ITEM CSL_CITATION {...}` span in your doc: it should be a blue underlined hyperlink pointing at `https://www.zotero.org/google-docs/?XXXXXX`. Same for the `DOCUMENT_PREFERENCES` paragraph at the bottom — it should be a hyperlink. If neither is linked, the version of `ZoteroTransfer.gs` in your Apps Script project is out of date; re-paste it from the latest `dist/INSTALL_PASTE.md`.

**You clicked "Cancel" on the native convert dialog** — That aborts the import. Zotero throws a `UserCancelled` exception and the doc stays as-is. Click Refresh again and choose "Continue".

**Nothing at all happens and no dialog appears** — Open the Google Docs tab's DevTools console (F12 → Console). After clicking Refresh, look for lines starting with `Zotero.debug('Google Docs ...'`. If you see `isExportedDocument() → false`, the marker isn't at the very top of the body. If you see `getFields` returning 0 fields and no import attempt at all, something else is wrong with the doc structure — contact the project maintainer with the debug output.

**To enable Zotero's full debug log**: in Zotero desktop, **Help → Debug Output Logging → Enable**, then click Refresh in your doc, then **Help → Debug Output Logging → View Output**. Look for `Integration: No importable data found` (missing hyperlinks on citation/prefs paragraphs) or `Interface.refresh` (marker not detected / normal refresh path taken).

**Citation marked broken after Zotero Refresh** — Almost always a user-ID mismatch in Settings. Double-check at https://www.zotero.org/settings/keys.

**Anthropic API returns "unknown tool type"** — The `web_search` tool name is versioned. Open `Llm.js` in the script editor, find `WEB_SEARCH_TYPE`, and update it to the current value from https://docs.anthropic.com/en/docs/build-with-claude/tool-use/web-search-tool.

**Find returns "Claude did not return a JSON array"** — The model occasionally adds prose around the JSON. Click the **show details** chevron under the failing tag to see the raw text and report it.

---

## For developers

If you want to edit code locally with `clasp` instead of pasting:

1. `npm install -g @google/clasp`
2. `clasp login`
3. Enable the Apps Script API at https://script.google.com/home/usersettings
4. Clone the existing project: `clasp clone <SCRIPT_ID> --rootDir src` (find the script ID in the editor URL)
5. Edit files in `src/`, then `clasp push`
6. After every source change, regenerate the paste bundle: `node build/build-paste-bundle.js`
7. Run the offline chunker sanity check: `node test/test-chunker.js`

You can revoke clasp's access any time at https://myaccount.google.com/permissions.
