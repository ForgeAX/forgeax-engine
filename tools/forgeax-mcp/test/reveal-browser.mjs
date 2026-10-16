import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { relative } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const [rootArg, url, sourceArg] = process.argv.slice(2);
if (!rootArg || !url || !sourceArg) throw new Error('Usage: reveal-browser.mjs <project-root> <View-url> <Pack-source>');
const root = resolve(rootArg);
const sourcePath = resolve(sourceArg);
const browser = await chromium.launch({
  ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}),
  headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--use-vulkan=swiftshader',
    '--use-angle=swiftshader', '--disable-gpu-driver-bug-workarounds',
    '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'],
  chromiumSandbox: true,
});
const client = new Client({ name: 'forgeax-view-reveal-browser', version: '0.0.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve(import.meta.dirname, '../src/mcp-stdio.mjs'), root],
  env: { ...process.env } });
await client.connect(transport);
const tool = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
const until = async (probe, message) => {
  for (let attempt = 0; attempt < 240; attempt++) {
    const value = await probe();
    if (value) return value;
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error(typeof message === 'function' ? await message() : message);
};
try {
  const first = await browser.newPage();
  await first.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await first.waitForURL(current => current.searchParams.has('forgeaxWorkspaceTarget'), { timeout: 180_000, waitUntil: 'domcontentloaded' });
  await first.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted, undefined, { timeout: 60_000 });
  let lastStatus;
  const firstStatus = await until(async () => {
    const result = await tool('forgeax_view_status', {});
    lastStatus = result;
    return result?.ok && result.value.pages?.length === 1 && result.value.pages[0].projectPhase === 'running' ? result.value : undefined;
  }, async () => `first View page did not connect: ${JSON.stringify({
    status: lastStatus,
    body: (await first.locator('body').innerText().catch(() => 'body unavailable')).slice(0, 900),
  })}`);
  const firstConnection = firstStatus.pages[0].connectionId;
  const single = process.env.FORGEAX_VIEW_SINGLE_PAGE === '1';
  const second = single ? undefined : await browser.newPage();
  if (second) {
    await second.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await second.waitForURL(current => current.searchParams.has('forgeaxWorkspaceTarget'), { timeout: 180_000, waitUntil: 'domcontentloaded' });
    await second.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted, undefined, { timeout: 60_000 });
  }
  const status = single ? firstStatus : await until(async () => {
    const result = await tool('forgeax_view_status', {});
    return result?.ok && result.value.pages?.length === 2 ? result.value : undefined;
  }, 'second View page did not connect');
  const addressed = status.pages.find(page => page.connectionId === firstConnection);
  assert.equal(addressed.project.root, root);
  const inspected = await tool('forgeax_asset_inspect', { subject: sourcePath });
  const revision = `sha256:${createHash('sha256').update(await readFile(sourcePath)).digest('hex')}`;
  if (inspected.ok) assert.equal(inspected.value.revision, revision);
  const args = { projectId: addressed.project.id, sourcePath: relative(root, sourcePath).split('\\').join('/'),
    revision, connectionId: firstConnection };
  if (second) {
    const displayTab = second.getByRole('tab', { name: /\u8fd0\u884c\u65f6\u622a\u56fe|Runtime Capture/ });
    await displayTab.click();
    assert.equal(await displayTab.getAttribute('aria-selected'), 'true');
    const ambiguous = await tool('forgeax_view_workspace_pack_reveal', { ...args, connectionId: undefined });
    assert.equal(ambiguous.error.code, 'view-page-ambiguous', JSON.stringify(ambiguous));
    const explicit = await tool('forgeax_view_workspace_pack_reveal', args);
    assert.equal(explicit.ok, true, JSON.stringify(explicit));
    assert.equal(explicit.value.code, 'shown');
    const card = first.locator(`[data-cb-path="${args.sourcePath}"]`).first();
    const other = second.locator(`[data-cb-path="${args.sourcePath}"]`).first();
    assert.equal(await card.isVisible(), true);
    assert.equal(await card.getAttribute('aria-selected'), 'true');
    assert.notEqual(await other.getAttribute('aria-selected').catch(() => null), 'true');
    assert.equal(await displayTab.getAttribute('aria-selected'), 'true',
      'a directed reveal must preserve the other page selected tab');
    console.log(JSON.stringify({ projectId: addressed.project.id, firstConnection,
      secondConnection: status.pages.find(page => page.connectionId !== firstConnection)?.connectionId,
      sourcePath: args.sourcePath, revision: args.revision, reveal: explicit.value.code }));
  } else {
    const revealed = await tool('forgeax_view_workspace_pack_reveal', args);
    if (!revealed.ok) console.error(JSON.stringify({ revealFailure: revealed,
      page: await first.evaluate(() => ({ activePage: document.documentElement.dataset.forgeaxViewActivePage,
        contentBrowser: document.querySelector('[data-testid="panel-content-browser"]')?.getBoundingClientRect().toJSON(),
        tabs: [...document.querySelectorAll('[role="tab"][data-page-id]')].map(tab => ({ id: tab.getAttribute('data-page-id'), selected: tab.getAttribute('aria-selected') })),
        body: document.body.innerText.slice(0, 900),
      })) }));
    assert.equal(revealed.ok, true, JSON.stringify(revealed));
    assert.equal(revealed.value.code, 'shown');
    const card = first.locator(`[data-cb-path="${args.sourcePath}"]`).first();
    assert.equal(await card.isVisible(), true);
    assert.equal(await card.getAttribute('aria-selected'), 'true');
    console.log(JSON.stringify({ projectId: addressed.project.id, firstConnection,
      sourcePath: args.sourcePath, revision: args.revision, reveal: revealed.value.code }));
  }
} finally {
  await client.close();
  await browser.close();
}
