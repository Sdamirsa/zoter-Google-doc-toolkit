/**
 * PubMed E-utilities — used in v0.1 only to convert PMID -> DOI so we can
 * then look the item up in the user's Zotero library.
 */

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

function PubMed_pmidToDoi(pmid) {
  const url = EUTILS + '/esummary.fcgi?db=pubmed&retmode=json&id=' + encodeURIComponent(pmid);
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  const j = JSON.parse(res.getContentText());
  const rec = j && j.result && j.result[pmid];
  if (!rec || !rec.articleids) return null;
  const doi = rec.articleids.find(a => a.idtype === 'doi');
  return doi ? doi.value : null;
}
