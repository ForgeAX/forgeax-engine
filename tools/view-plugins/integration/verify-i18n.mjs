import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createProfiler } from '@forgeax/engine-profiler';
import { encodeTape } from '@forgeax/engine-rhi-debug';

const url = process.argv[2];
if (!url) throw new Error('Usage: node tools/view-plugins/integration/verify-i18n.mjs <View URL>');
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? resolve(tmpdir(), 'forgeax-diagnostics-i18n'));
await mkdir(output, { recursive: true });
function unwrap(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
const profiler = createProfiler({ phaseCatalog: { app: ['update'], render: [] } });
const recording = unwrap(profiler.startCapture({ frameLimit: 2, eventLimit: 8 }));
unwrap(recording.beginFrame(1));
unwrap(recording.beginPhase('app', 'update'));
unwrap(recording.endPhase());
unwrap(recording.endFrame());
const capture = unwrap(recording.finish());
const tape = unwrap(encodeTape({
  header: { formatVersion: 7, rhiCaps: {}, eventCount: 5, blobCount: 0 },
  bootstrap: [
    { handleId: 'encoder:1', kind: 'encoder', create: { kind: 'createCommandEncoder', cmdHandleId: 'encoder:1' }, initialData: [] },
    { handleId: 'texture:color', kind: 'texture', create: { kind: 'createTexture', handleId: 'texture:color', desc: { size: [2, 2, 1], format: 'rgba8unorm', usage: 17, dimension: '2d', mipLevelCount: 1, sampleCount: 1 } }, initialData: [] },
    { handleId: 'view:color', kind: 'texture-view', create: { kind: 'createTextureView', sourceHandleId: 'texture:color', resultHandleId: 'view:color', desc: {} }, initialData: [] },
  ],
  events: [
    { kind: 'frameMark', frameIdx: 0 },
    { kind: 'beginRenderPass', cmdHandleId: 'encoder:1', passHandleId: 'pass:1', desc: { colorAttachments: [] }, colorAttachmentViewHandleIds: ['view:color'] },
    { kind: 'draw', passHandleId: 'pass:1', vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
    { kind: 'endRenderPass', passHandleId: 'pass:1' },
    { kind: 'submit', cmdHandleIds: ['encoder:1'] },
  ],
  blobs: [],
}));
const browser = await chromium.launch({ headless: true, channel: 'chrome', chromiumSandbox: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('forgeax.view.locale', 'en');
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  });
  await page.goto(url);
  await page.waitForFunction(() => globalThis.__forgeaxViewReady?.mounted);
  const language = async locale => {
    await page.getByRole('button', { name: /^(Language|语言)$/ }).click();
    await page.getByRole('menuitem', { name: locale === 'en' ? 'English' : '简体中文', exact: true }).click();
  };
  await page.getByRole('tab', { name: 'CPU Profiler', exact: true }).click();
  const profile = page.locator('.fx-profile');
  await profile.locator('input[type="file"]').setInputFiles({ name: 'locale-capture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(capture)) });
  await profile.locator('[data-profile-frames="1"]').waitFor();
  await page.evaluate(() => { globalThis.__profileChart = document.querySelector('[data-profile-frames]'); });
  await language('zh');
  await profile.getByRole('button', { name: '打开捕获文件' }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.__profileChart === document.querySelector('[data-profile-frames]')), true);
  assert.match(await profile.innerText(), /locale-capture.json/);
  await page.screenshot({ path: resolve(output, 'profiler-zh.png') });

  await page.getByRole('tab', { name: 'RHI 调试', exact: true }).click();
  const rhi = page.locator('.rhi-viewer');
  await rhi.locator('input[type="file"]').setInputFiles({ name: 'locale-tape.rhitape', mimeType: 'application/octet-stream', buffer: Buffer.from(tape) });
  await rhi.locator('[data-forgeax-work-index="0"]').first().click();
  await rhi.getByText('像素不可用：无 WebGPU', { exact: true }).waitFor();
  await rhi.getByRole('tab', { name: '资源检查器', exact: true }).click();
  await rhi.locator('[data-forgeax-resource-row="texture:color"]').click();
  await rhi.getByRole('searchbox', { name: '筛选资源 ID' }).fill('texture:');
  await page.evaluate(() => {
    globalThis.__rhiLocaleState = {
      api: globalThis.__forgeaxRhiDebug,
      selection: globalThis.__forgeaxRhiDebug.selection,
      input: document.querySelector('.rhi-viewer input[type="search"]'),
      groups: [...document.querySelectorAll('.rhi-viewer .dv-groupview')],
    };
  });
  await language('en');
  await rhi.getByRole('tab', { name: 'Resource Inspector', exact: true }).waitFor();
  assert.equal(await rhi.getByRole('searchbox', { name: 'Filter resource IDs' }).inputValue(), 'texture:');
  assert.equal(await page.evaluate(() => {
    const previous = globalThis.__rhiLocaleState, current = globalThis.__forgeaxRhiDebug;
    return previous.api.model === current.model && previous.api.inspectWork === current.inspectWork
      && previous.api.readResource === current.readResource
      && JSON.stringify(previous.selection) === JSON.stringify(current.selection)
      && previous.input === document.querySelector('.rhi-viewer input[type="search"]')
      && previous.groups.every((group, index) => group === document.querySelectorAll('.rhi-viewer .dv-groupview')[index]);
  }), true, 'language changes preserve loaded tape, replay functions, selection, layout and actual input');
  await language('zh');
  await rhi.getByRole('button', { name: '清除搜索', exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'rhi-debug-zh.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: resolve(output, 'rhi-debug-zh-mobile.png') });
  await page.getByRole('tab', { name: 'CPU 性能分析器', exact: true }).click();
  await page.screenshot({ path: resolve(output, 'profiler-zh-mobile.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, output, evidence: 'UI locale retention; no GPU acceptance' }));
} catch (error) {
  for (const page of browser.contexts().flatMap(context => context.pages())) {
    console.error(JSON.stringify({ tabs: await page.getByRole('tab').allTextContents(), text: (await page.locator('body').innerText()).slice(-1600) }));
    await page.screenshot({ path: resolve(output, 'failure.png') });
  }
  throw error;
} finally {
  await browser.close();
}
