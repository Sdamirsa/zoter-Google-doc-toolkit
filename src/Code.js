/**
 * Zoter Toolkit — entry points.
 * Menu + sidebar wiring. Business logic lives in Resolver / Find / ZoteroField.
 */

function onOpen(e) {
  DocumentApp.getUi()
    .createMenu('My Happy Zotero Toolkit')
    .addItem('Open sidebar', 'showSidebar')
    .addSeparator()
    .addItem('Scan tags', 'showSidebar')
    .addItem('Resolve all [@zotero:...]', 'showSidebar')
    .addItem('Find candidates for [@zotero:find]', 'showSidebar')
    .addSeparator()
    .addItem('Settings', 'showSettings')
    .addToUi();

  // Auto-open the sidebar when the doc loads, so the user doesn't have to
  // dig through the Extensions menu every time. Apps Script is limited to
  // menus + sidebars + dialogs — it can't add a toolbar button or tab.
  // This is the closest thing to a "one-click open" that the platform
  // allows.
  //
  // Guarded because onOpen runs in AuthMode.LIMITED the first time a user
  // opens a doc after installing the add-on, and showSidebar needs full
  // auth. If we throw here the menu fails to load too, which would be
  // worse UX.
  try {
    if (!e || e.authMode !== ScriptApp.AuthMode.NONE) {
      showSidebar();
    }
  } catch (err) {
    // Ignore — user can still open the sidebar from the menu.
  }
}

function onInstall(e) { onOpen(); }

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('My Happy Zotero Toolkit');
  DocumentApp.getUi().showSidebar(html);
}

function showSettings() {
  const html = HtmlService.createHtmlOutputFromFile('Settings')
    .setTitle('My Happy Zotero Toolkit — Settings')
    .setWidth(440).setHeight(440);
  DocumentApp.getUi().showModalDialog(html, 'My Happy Zotero Toolkit — Settings');
}

/* ---------- settings persistence ---------- */

function getSettings() {
  const p = PropertiesService.getUserProperties();
  return {
    zoteroUserId: p.getProperty('zoteroUserId') || '',
    zoteroApiKey: p.getProperty('zoteroApiKey') || '',
    zoteroGroupIds: p.getProperty('zoteroGroupIds') || '',
    anthropicApiKey: p.getProperty('anthropicApiKey') || '',
    defaultStyle: p.getProperty('defaultStyle') || 'apa'
  };
}

function saveSettings(s) {
  const p = PropertiesService.getUserProperties();
  if (s.zoteroUserId != null) p.setProperty('zoteroUserId', String(s.zoteroUserId).trim());
  if (s.zoteroApiKey != null) p.setProperty('zoteroApiKey', String(s.zoteroApiKey).trim());
  if (s.zoteroGroupIds != null) p.setProperty('zoteroGroupIds', String(s.zoteroGroupIds).trim());
  if (s.anthropicApiKey != null) p.setProperty('anthropicApiKey', String(s.anthropicApiKey).trim());
  if (s.defaultStyle != null) p.setProperty('defaultStyle', String(s.defaultStyle).trim() || 'apa');
  return getSettings();
}

function testAnthropic() {
  return Llm_testConnection(getSettings());
}

/* ---------- sidebar-callable actions ---------- */

function uiScan() {
  const tags = Resolver_findTags();
  const itemBlocks = ZoteroTransfer_countItemBlocks();
  return {
    tagCount: tags.length,
    fieldCount: itemBlocks,
    tags: tags.map(t => ({
      raw: t.raw,
      kind: t.kind,
      id: t.id,
      locator: t.locator || '',
      paragraph: t.paragraphIndex,
      mode: t.mode || null,
      n: t.n || null
    }))
  };
}

function uiResolveAll() {
  const settings = getSettings();
  if (!settings.zoteroUserId || !settings.zoteroApiKey) {
    return { ok: false, error: 'Set Zotero user ID and API key in Settings first.' };
  }
  return Resolver_resolveAll(settings);
}

/**
 * Resolve exactly one [@zotero:...] tag — the one at the highest offset in
 * the doc. Client calls this repeatedly in a loop to drive a progress bar.
 * Failed tags are tracked in CacheService so the loop doesn't retry them
 * forever.
 */
function uiResolveNext() {
  const settings = getSettings();
  if (!settings.zoteroUserId || !settings.zoteroApiKey) {
    return { ok: false, error: 'Set Zotero user ID and API key in Settings first.' };
  }
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) {
    return { ok: false, error: 'Another operation is running. Wait and retry.' };
  }
  try {
    const cache = CacheService.getDocumentCache();
    const failKey = 'zoter_resolve_failed';
    const failed = JSON.parse(cache.get(failKey) || '[]');
    const failedSet = {};
    failed.forEach(k => failedSet[k] = true);

    const allTags = Resolver_findTags().filter(t => t.kind !== 'find');
    const todo = allTags.filter(t => !failedSet[t.raw + '@' + t.paragraphIndex]);

    if (!todo.length) {
      cache.remove(failKey);
      return { ok: true, done: true, remaining: 0 };
    }

    // Process the tag with the highest start offset first so earlier
    // tags' offsets stay valid across the sequence of mutations.
    todo.sort((a, b) => b.start - a.start);
    const t = todo[0];
    try {
      const res = Resolver_resolveOne(t, settings);
      return {
        ok: true,
        done: todo.length === 1,
        remaining: todo.length - 1,
        processed: {
          raw: t.raw,
          status: 'ok',
          title: res.title,
          paragraph: t.paragraphIndex
        }
      };
    } catch (e) {
      failed.push(t.raw + '@' + t.paragraphIndex);
      cache.put(failKey, JSON.stringify(failed), 600);
      return {
        ok: true,
        done: todo.length === 1,
        remaining: todo.length - 1,
        processed: {
          raw: t.raw,
          status: 'error',
          error: String(e.message || e),
          paragraph: t.paragraphIndex
        }
      };
    }
  } finally {
    lock.releaseLock();
  }
}

/** Called by the client after the resolve loop finishes. */
function uiEnsureMarkers() {
  const settings = getSettings();
  try {
    ZoteroTransfer_ensureMarkers(settings.defaultStyle);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Clear the failed-tag cache at the start of a new resolve loop. */
function uiResolveClearFailed() {
  CacheService.getDocumentCache().remove('zoter_resolve_failed');
  return { ok: true };
}

/**
 * Process one [@zotero:find] tag per call: asks Claude for three
 * classified references (orig / rev / contra) and replaces the tag with
 * an inline hyperlinked parenthetical. The client drives this in a loop
 * with a progress bar and renders a card per tag.
 */
function uiFindNext() {
  const settings = getSettings();
  if (!settings.anthropicApiKey) {
    return { ok: false, error: 'Set Anthropic API key in Settings first.' };
  }
  return Find_findNext(settings);
}

function uiFindClearCache() {
  Find_clearCache();
  return { ok: true };
}

/**
 * Diagnostic: dump current settings (keys redacted) and probe each
 * configured Zotero library with a 1-item fetch so the user can see
 * exactly which libraries are reachable with their API key.
 */
function uiDiagnose() {
  const settings = getSettings();
  const out = {
    zoteroUserId: settings.zoteroUserId || '(unset)',
    zoteroGroupIds: settings.zoteroGroupIds || '(none)',
    zoteroApiKeySet: !!settings.zoteroApiKey,
    anthropicApiKeySet: !!settings.anthropicApiKey,
    defaultStyle: settings.defaultStyle,
    librariesSearched: ZoteroApi_describeLibraries(settings),
    libraryProbes: []
  };
  if (settings.zoteroApiKey && (settings.zoteroUserId || settings.zoteroGroupIds)) {
    out.libraryProbes = ZoteroApi_probeLibraries(settings);
  }
  return out;
}
