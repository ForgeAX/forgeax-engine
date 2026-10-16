export type ProjectFile = { path: string; kind: string; mime: string; size: number; mtime: number; content?: string; dataUrl?: string };
export type ProjectFileReader = (path: string, options?: { signal?: AbortSignal }) => Promise<ProjectFile | null>;

const CSP = "default-src 'none'; img-src data:; font-src data:; media-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

export function resolveProjectReference(owner: string, reference: string) {
  const raw = reference.trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/')) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(raw.split(/[?#]/, 1)[0]!); } catch { return null; }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const parts = owner.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

export async function resolveStandaloneHtml(html: string, path: string, read: ProjectFileReader, signal?: AbortSignal) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const issues: string[] = [];
  const cache = new Map<string, Promise<ProjectFile | null>>();
  const fetchRelative = async (owner: string, reference: string) => {
    const resolved = resolveProjectReference(owner, reference);
    if (!resolved) { issues.push(`Blocked resource: ${reference}`); return null; }
    if (!cache.has(resolved)) cache.set(resolved, read(resolved, { signal }).catch((error: unknown) => { issues.push(`Failed resource ${resolved}: ${error instanceof Error ? error.message : String(error)}`); return null; }));
    const result = await cache.get(resolved)!;
    if (!result) issues.push(`Missing resource: ${resolved}`);
    return result;
  };
  const css = async (value: string, owner: string) => {
    let output = value.replace(/@import\s+(?:url\([^)]*\)|["'][^"']+["'])\s*[^;]*;/gi, (rule) => { issues.push(`Unsupported CSS import: ${rule}`); return ''; });
    const matches = [...output.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)];
    for (const match of matches) {
      const reference = match[2]!.trim();
      if (reference.startsWith('data:') || reference.startsWith('#')) continue;
      const file = await fetchRelative(owner, reference);
      const dataUrl = file?.dataUrl ?? (file?.mime === 'image/svg+xml' && file.content ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content)}` : undefined);
      output = output.replace(match[0], dataUrl ? `url("${dataUrl}")` : 'url("")');
      if (file && !dataUrl) issues.push(`Unsupported CSS resource: ${reference}`);
    }
    return output;
  };
  for (const element of [...document.querySelectorAll('base, meta[http-equiv="refresh"]')]) { issues.push(`Blocked element: <${element.tagName.toLowerCase()}>`); element.remove(); }
  for (const element of [...document.querySelectorAll('link')]) {
    if (!element.getAttribute('rel')?.toLowerCase().split(/\s+/).includes('stylesheet')) { issues.push(`Unsupported link: ${element.getAttribute('href') ?? ''}`); element.remove(); continue; }
    const reference = element.getAttribute('href') ?? '';
    const file = await fetchRelative(path, reference);
    if (file?.content == null) { if (file) issues.push(`Unsupported stylesheet: ${reference}`); element.remove(); continue; }
    const style = document.createElement('style');
    style.textContent = (await css(file.content, file.path)).replaceAll('<', '\\3C ');
    style.dataset.forgeaxResolved = 'true';
    element.replaceWith(style);
  }
  for (const element of [...document.querySelectorAll('style:not([data-forgeax-resolved])')]) element.textContent = (await css(element.textContent ?? '', path)).replaceAll('<', '\\3C ');
  for (const element of [...document.querySelectorAll('[style]')]) element.setAttribute('style', await css(element.getAttribute('style') ?? '', path));
  for (const element of [...document.querySelectorAll('script')]) {
    if (element.getAttribute('type') === 'module') { issues.push('Module scripts and imports are unsupported.'); element.remove(); continue; }
    const reference = element.getAttribute('src');
    if (reference) {
      const file = await fetchRelative(path, reference);
      element.removeAttribute('src');
      if (file?.content != null) element.textContent = file.content.replace(/<\/script/gi, '<\\/script');
      else { if (file) issues.push(`Unsupported script: ${reference}`); element.remove(); continue; }
    }
    if (/\bimport\s*(?:\(|["'{*])/.test(element.textContent ?? '')) issues.push('Module imports are unsupported.');
    if (/\b(?:fetch\s*\(|XMLHttpRequest|WebSocket\s*\(|EventSource\s*\()/.test(element.textContent ?? '')) issues.push('Network APIs are unavailable in the sandboxed preview.');
  }
  for (const element of [...document.querySelectorAll('img, source, video, audio')]) {
    if (element.hasAttribute('srcset')) { issues.push('Responsive srcset resources are unsupported.'); element.removeAttribute('srcset'); }
    const reference = element.getAttribute('src');
    if (!reference) continue;
    if (reference.startsWith('data:')) continue;
    const file = await fetchRelative(path, reference);
    if (file?.dataUrl) element.setAttribute('src', file.dataUrl);
    else if (file?.mime === 'image/svg+xml' && file.content) element.setAttribute('src', `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content)}`);
    else { element.removeAttribute('src'); if (file) issues.push(`Unsupported media resource: ${reference}`); }
  }
  for (const element of [...document.querySelectorAll('a[href]')]) {
    const href = element.getAttribute('href') ?? '';
    if (!href.startsWith('#')) { issues.push(`Navigation unavailable: ${href}`); element.setAttribute('href', '#'); }
  }
  for (const element of [...document.querySelectorAll('iframe, object, embed')]) { issues.push(`Embedded content is unsupported: <${element.tagName.toLowerCase()}>`); element.remove(); }
  for (const element of [...document.querySelectorAll('form[action], video[poster]')]) {
    if (element.hasAttribute('action')) { issues.push('Form navigation is unavailable.'); element.removeAttribute('action'); }
    if (element.hasAttribute('poster')) { issues.push('Video poster resources are unsupported.'); element.removeAttribute('poster'); }
  }
  for (const meta of [...document.querySelectorAll('meta[http-equiv="content-security-policy"]')]) meta.remove();
  if (/\.ui\.html$/i.test(path)) {
    const companion = path.split('/').at(-1)!.replace(/\.ui\.html$/i, '.ui.css');
    const file = await fetchRelative(path, companion);
    const host = document.createElement('div');
    host.dataset.forgeaxUiHost = '';
    host.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    const shadow = document.createElement('template');
    shadow.setAttribute('shadowrootmode', 'open');
    if (file?.content != null) {
      const style = document.createElement('style');
      style.textContent = (await css(file.content, file.path)).replaceAll('<', '\\3C ');
      shadow.content.append(style);
    }
    const content = document.createElement('div');
    content.style.pointerEvents = 'none';
    while (document.body.firstChild) content.append(document.body.firstChild);
    shadow.content.append(content);
    host.append(shadow);
    document.body.style.margin = '0';
    document.body.append(host);
  }
  const policy = document.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', CSP);
  document.head.prepend(policy);
  const srcdoc = `<!doctype html>\n${document.documentElement.outerHTML}`;
  const host = document.querySelector('[data-forgeax-ui-host]');
  if (!host) return { srcdoc, issues: [...new Set(issues)] };
  host.classList.add('touch');
  return { srcdoc, touchSrcdoc: `<!doctype html>\n${document.documentElement.outerHTML}`, issues: [...new Set(issues)] };
}
