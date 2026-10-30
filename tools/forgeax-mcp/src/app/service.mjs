import { MCP_NATIVE_IMPORT_SOURCE } from '../contract.ts';
import { readFile } from 'node:fs/promises';
import { readResourceBytes } from './resource-bytes.ts';
import { createNetworkBroker } from './broker.mjs';
import { createRemoteBundler } from './bundler.mjs';

/** Adapt public View startup and admitted Engine documents to MCP resource bytes. */
export function createViewService(
  client,
  { artifactRoot = new URL('../../dist/', import.meta.url), viewDocument = 'full-view.html' } = {},
) {
  let active;
  let opening;
  const retire = state => {
    state.lifetime.abort(new Error('MCP presentation retired'));
    state.documents.clear();
    state.broker.close();
  };
  const open = () => {
    if (opening) return opening;
    opening = (async () => {
      const result = await client.request('view.start', {});
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const viewUrl = result.value.url;
      const presentationId = result.value.presentationId;
      if (typeof viewUrl !== 'string')
        throw new Error('Public view.start did not return a View URL');
      if (typeof presentationId !== 'string')
        throw new Error('Public view.start did not return a presentation identity');
      if (!active || active.config.viewUrl !== viewUrl || active.config.presentationId !== presentationId) {
        if (active) retire(active);
        const config = { viewUrl, presentationId };
        const lifetime = new AbortController();
        const broker = createNetworkBroker(config, { bundle: (...args) => bundle(...args) });
        const bundle = createRemoteBundler(broker.allow, { signal: lifetime.signal });
        active = { config, broker, bundle, lifetime, documents: new Map() };
      }
      return { root: client.root, url: viewUrl, presentationId };
    })().finally(() => {
      opening = undefined;
    });
    return opening;
  };
  const escape = (source) => source.replaceAll('</script', '<\\/script');
  async function invoke(input, options = {}) {
    if (!active) await open();
    const { config, broker } = active;
    if (input.action === 'view-document') {
      const html = (await readFile(new URL(viewDocument, artifactRoot), 'utf8')).replace(
        '__FX_VIEW_CONFIG__',
        () => JSON.stringify(config).replaceAll('<', '\\u003c'),
      );
      return broker.store(html, 'text/html', config.viewUrl);
    }
    if (input.action !== 'document' && input.action !== 'document-cancel') return broker.invoke(input, options);
    // An old presentation already retired its jobs and may no longer admit
    // this origin. Cancellation only touches an existing job; it fetches nothing.
    const url = input.action === 'document-cancel' ? new URL(input.url).href : broker.allow(input.url).href;
    const documents = active.documents;
    const existing = documents.get(url);
    if (input.action === 'document-cancel') {
      documents.delete(url);
      existing?.controller.abort(new Error('MCP document retired'));
      return { cancelled: existing !== undefined };
    }
    if (existing) {
      if (existing.phase === 'pending') return { phase: 'pending' };
      documents.delete(url);
      if (existing.phase === 'failed') throw existing.error;
      return { phase: 'ready', reference: existing.reference };
    }
    if (documents.size >= 32) throw new Error('MCP document task bound exceeded');
    const task = { phase: 'pending', controller: new AbortController() };
    documents.set(url, task);
    // Compilation belongs to the presentation, not a short-lived RPC signal.
    // Every query remains bounded while the existing Scene deadline qualifies it.
    void compileDocument(url, active, task.controller.signal).then(
      reference => Object.assign(task, { phase: 'ready', reference }),
      error => Object.assign(task, { phase: 'failed', error }),
    );
    return { phase: 'pending' };
  }
  async function compileDocument(url, { broker, bundle, lifetime }, signal) {
    const options = { signal: AbortSignal.any([lifetime.signal, signal]) };
    const ref = await broker.invoke({ action: 'http', url }, options);
    if (ref.status < 200 || ref.status >= 300)
      throw new Error(`Engine document HTTP ${ref.status}: ${new URL(url).pathname}`);
    let html = new TextDecoder().decode(await readResourceBytes(ref, args => broker.invoke(args, options)));
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((match) =>
      /type\s*=\s*["']module/.test(match[1]),
    );
    const entry = scripts
      .map((match) => match[1].match(/src\s*=\s*["']([^"']+)/)?.[1])
      .filter(Boolean)
      .findLast((value) => !value.includes('@vite/client'));
    const inline = scripts
      .filter((match) => !match[1].match(/src\s*=/))
      .map((match) => match[2])
      .join('\n');
    if (!entry && !inline) throw new Error('Engine document has no module entry');
    const compiled = await bundle(
      entry
        ? new URL(entry, url).href
        : new URL('./__mcp_document_entry.mjs', url).href,
      'document',
      entry ? undefined : inline,
      options.signal,
    );
    html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (text, attrs) =>
      /type\s*=\s*["']module/.test(attrs) ? '' : text,
    );
    html = html.replace(/\blocation\.search\b/g, 'globalThis.__fxMcpLocation.search');
    html = html.replace(
      '<head>',
      () =>
        '<head><script>globalThis.__fxMcpLocation=new URL(' +
        JSON.stringify(url).replaceAll('<', '\\u003c') +
        ');' + MCP_NATIVE_IMPORT_SOURCE + '</script>',
    );
    const payload = `<script id="fx-config" type="application/json">${JSON.stringify({ documentUrl: url }).replaceAll('<', '\\u003c')}</script><script type="module">${escape(compiled.source)}</script>`;
    return broker.store(
      html.replace('</body>', () => payload + '</body>'),
      'text/html',
      url,
    );
  }
  return {
    invoke,
    open,
    close() {
      if (active) retire(active);
      active = undefined;
    },
  };
}
