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
        active?.broker.close();
        const config = { viewUrl, presentationId };
        const broker = createNetworkBroker(config, { bundle: (...args) => bundle(...args) });
        const bundle = createRemoteBundler(broker.allow);
        active = { config, broker, bundle };
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
    const { config, broker, bundle } = active;
    if (input.action === 'view-document') {
      const html = (await readFile(new URL(viewDocument, artifactRoot), 'utf8')).replace(
        '__FX_VIEW_CONFIG__',
        () => JSON.stringify(config).replaceAll('<', '\\u003c'),
      );
      return broker.store(html, 'text/html', config.viewUrl);
    }
    if (input.action !== 'document') return broker.invoke(input, options);
    const ref = await broker.invoke({ action: 'http', url: input.url }, options);
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
        ? new URL(entry, input.url).href
        : new URL('./__mcp_document_entry.mjs', input.url).href,
      'editor',
      entry ? undefined : inline,
    );
    html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (text, attrs) =>
      /type\s*=\s*["']module/.test(attrs) ? '' : text,
    );
    html = html.replace(/\blocation\.search\b/g, 'globalThis.__fxMcpLocation.search');
    html = html.replace(
      '<head>',
      () =>
        '<head><script>globalThis.__fxMcpLocation=new URL(' +
        JSON.stringify(input.url).replaceAll('<', '\\u003c') +
        ');' + MCP_NATIVE_IMPORT_SOURCE + '</script>',
    );
    const payload = `<script id="fx-config" type="application/json">${JSON.stringify({ documentUrl: input.url }).replaceAll('<', '\\u003c')}</script><script type="module">${escape(compiled.source)}</script>`;
    return broker.store(
      html.replace('</body>', () => payload + '</body>'),
      'text/html',
      input.url,
    );
  }
  return {
    invoke,
    open,
    close() {
      active?.broker.close();
      active = undefined;
    },
  };
}
