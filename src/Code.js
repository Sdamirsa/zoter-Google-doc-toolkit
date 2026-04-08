/**
 * Zoter Toolkit — entry points.
 * Menu + sidebar wiring. Business logic lives in Resolver/ZoteroField/ZoteroApi.
 */

function onOpen() {
  DocumentApp.getUi()
    .createMenu('Zoter Toolkit')
    .addItem('Open sidebar', 'showSidebar')
    .addSeparator()
    .addItem('Scan tags', 'uiScan')
    .addItem('Resolve all [@zotero:...]', 'uiResolveAll')
    .addSeparator()
    .addItem('Settings', 'showSettings')
    .addToUi();
}

function onInstall(e) { onOpen(); }

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Zoter Toolkit');
  DocumentApp.getUi().showSidebar(html);
}

function showSettings() {
  const html = HtmlService.createHtmlOutputFromFile('Settings')
    .setTitle('Zoter Toolkit — Settings')
    .setWidth(420).setHeight(360);
  DocumentApp.getUi().showModalDialog(html, 'Zoter Toolkit — Settings');
}

/* ---------- settings persistence ---------- */

function getSettings() {
  const p = PropertiesService.getUserProperties();
  return {
    zoteroUserId: p.getProperty('zoteroUserId') || '',
    zoteroApiKey: p.getProperty('zoteroApiKey') || '',
    defaultStyle: p.getProperty('defaultStyle') || 'apa'
  };
}

function saveSettings(s) {
  const p = PropertiesService.getUserProperties();
  if (s.zoteroUserId != null) p.setProperty('zoteroUserId', String(s.zoteroUserId).trim());
  if (s.zoteroApiKey != null) p.setProperty('zoteroApiKey', String(s.zoteroApiKey).trim());
  if (s.defaultStyle != null) p.setProperty('defaultStyle', String(s.defaultStyle).trim() || 'apa');
  return getSettings();
}

/* ---------- sidebar-callable actions ---------- */

function uiScan() {
  const tags = Resolver_findTags();
  const fields = ZoteroField_listExisting();
  return {
    tagCount: tags.length,
    fieldCount: fields.length,
    tags: tags.map(t => ({ raw: t.raw, kind: t.kind, id: t.id, locator: t.locator || '' }))
  };
}

function uiResolveAll() {
  const settings = getSettings();
  if (!settings.zoteroUserId || !settings.zoteroApiKey) {
    return { ok: false, error: 'Set Zotero user ID and API key in Settings first.' };
  }
  return Resolver_resolveAll(settings);
}
