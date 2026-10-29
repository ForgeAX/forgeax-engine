export function isCodexBrowser(document: Document) {
  const oai = (document as Document & { oai?: object }).oai;
  return Boolean(oai && 'annotation' in oai);
}
