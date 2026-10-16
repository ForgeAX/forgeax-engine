import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// The emitted View and its host decoration must initialize in one React realm.
// The Host request is held after handshake: this gate does not qualify Engine/GPU work.
const view = await readFile(resolve(import.meta.dirname, '../dist/codex-view.html'), 'utf8');
const host = await build({
  stdin: {
    resolveDir: import.meta.dirname,
    contents: `
      import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
      const frame = document.querySelector('iframe');
      const bridge = new AppBridge(null, {name:'Frontend startup',version:'1'},
        {serverTools:{},experimental:{'openai/message':{}}}, {hostContext:{theme:'light'}});
      bridge.oncalltool = params => {
        window.firstTool = params;
        return new Promise(() => {});
      };
      await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
      frame.srcdoc = await (await fetch('/view')).text();
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  if (request.url === '/view') {
    response.end(view.replace('__FX_VIEW_CONFIG__', JSON.stringify({
      viewUrl: `http://127.0.0.1:${server.address().port}/view`,
      presentationId: 'frontend-startup',
    })));
    return;
  }
  response.end(`<iframe sandbox="allow-scripts"></iframe><script type="module">${host.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);
});
let browser;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch({
    executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE,
    headless: true,
    chromiumSandbox: true,
  });
  const page = await browser.newPage();
  const errors = [];
  let rejectRuntime;
  const runtimeFailure = new Promise((_, reject) => { rejectRuntime = reject; });
  page.on('pageerror', error => { errors.push(error.message); rejectRuntime(error); });
  await Promise.all([
    page.goto(`http://127.0.0.1:${server.address().port}/`),
    Promise.race([
      page.waitForFunction(() => !!window.firstTool, undefined, { timeout: 60000 }),
      runtimeFailure,
    ]),
  ]);
  assert.deepEqual(errors, []);
  const tool = await page.evaluate(() => window.firstTool);
  assert.ok(tool.arguments.action);
  console.log(JSON.stringify({ ok: true, firstAction: tool.arguments.action,
    boundary: 'actual emitted Codex View + native MCP handshake; no Engine/GPU acceptance' }));
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
