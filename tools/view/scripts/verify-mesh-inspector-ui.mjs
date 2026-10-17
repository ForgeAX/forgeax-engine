/** Chromium layout/interaction evidence with deterministic data; no Engine/GPU claim. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/mesh-inspector-ui');
const temporary = await mkdtemp(resolve(tmpdir(), 'view-mesh-inspector-ui-'));
let browser;
let server;
try {
  await mkdir(output, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: ['test/fixtures/mesh-inspector-ui.tsx'], outfile: resolve(temporary, 'ui.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic' });
  const html = '<!doctype html><html lang="zh" data-theme="light"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/ui.css"><style>body{margin:0}#app{height:860px;width:100%}</style><div id="app"></div><script type="module" src="/ui.js"></script></html>';
  server = createServer(async (request, response) => {
    if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
    if (!['/ui.js', '/ui.css'].includes(request.url)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(resolve(temporary, request.url.slice(1))));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}), chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: 480, height: 860 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const panel = page.getByTestId('panel-inspector');
  await page.getByTestId('insp-entity-body').waitFor();
  assert.equal(await panel.getByTestId('insp-group-common').getAttribute('aria-checked'), 'true');
  assert.equal(await panel.locator('.insp-detail-section').count(), 3);
  assert.equal(await panel.getByTestId('insp-material-slot-0').count(), 1);
  assert.equal(await panel.getByTestId('insp-material-slot-2').count(), 1);
  const meshOpen = () => panel.getByTestId('insp-section-mesh').locator('.asset-ref-combo');
  assert.equal(await meshOpen().isDisabled(), true);
  const transformHeading = panel.getByTestId('insp-section-Transform').locator('.fx-collapsible__heading');
  const transformCopy = transformHeading.locator('.insp-component-copy');
  await page.mouse.move(0, 0);
  assert.deepEqual(await panel.locator('.insp-component-copy').evaluateAll(buttons => buttons.map(button => getComputedStyle(button).opacity)), ['0', '0', '0']);
  const copyBounds = await transformCopy.boundingBox();
  await transformHeading.hover();
  assert.deepEqual(await panel.locator('.insp-component-copy').evaluateAll(buttons => buttons.map(button => getComputedStyle(button).opacity)), ['1', '0', '0']);
  assert.deepEqual(await transformCopy.boundingBox(), copyBounds);
  await panel.getByTestId('insp-field-Transform-pos').hover();
  assert.equal(await transformCopy.evaluate(button => getComputedStyle(button).opacity), '0');
  await transformHeading.locator('.fx-collapsible__trigger').focus();
  await page.keyboard.press('Tab');
  assert.equal(await transformCopy.evaluate(button => button.matches(':focus-visible')), true);
  assert.equal(await transformCopy.evaluate(button => getComputedStyle(button).opacity), '1');
  const componentCopyWrites = await page.evaluate(() => globalThis.meshInspectorFixture.clipboardWrites());
  await transformCopy.press('Enter');
  const copiedComponent = JSON.parse(await page.evaluate(() => globalThis.meshInspectorFixture.copyText()));
  assert.equal(copiedComponent.name, 'Transform');
  assert.deepEqual(copiedComponent.values.quat, [-0.2588190451, 0, 0, 0.9659258263]);
  assert.equal(await page.evaluate(() => globalThis.meshInspectorFixture.clipboardWrites()), componentCopyWrites + 1);
  await panel.getByTestId('insp-search').focus();
  await page.mouse.move(0, 0);
  assert.equal(await panel.getByTestId('insp-root-node').count(), 0);
  assert.equal(await panel.getByTestId('insp-component-list').locator('button').count(), 11);
  for (const component of ['Entity', 'Transform', 'GlobalTransform', 'TransformInterpolation', 'ChildOf', 'Name', 'MeshFilter', 'MeshRenderer']) {
    assert.equal(await panel.getByTestId(`insp-comprow-${component}`).count(), 1);
  }
  assert.deepEqual(await panel.getByTestId('insp-field-Transform-quat').locator('input').evaluateAll(inputs => inputs.map(input => input.value)), ['-30.0°', '0.0°', '0.0°']);
  assert.deepEqual(await panel.getByTestId('insp-field-Transform-pos').locator('.fx-inspector-form__vcell').evaluateAll(cells =>
    cells.map(cell => ({ label: getComputedStyle(cell, '::before').content, layer: getComputedStyle(cell, '::before').zIndex }))),
  [{ label: '"X"', layer: '1' }, { label: '"Y"', layer: '1' }, { label: '"Z"', layer: '1' }]);
  for (const theme of ['light', 'dark']) for (const width of [220, 280, 300, 320, 480, 640]) {
    await page.setViewportSize({ width, height: 860 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: resolve(output, `common-${theme}-${width}.png`) });
    const geometry = await panel.evaluate(element => {
      const controls = [...element.querySelectorAll('button, input')].filter(control => control.getClientRects().length);
      const escaped = controls.filter(control => { const rect = control.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1; }).map(control => control.outerHTML);
      const textContext = new OffscreenCanvas(1, 1).getContext('2d');
      const clippedValues = [...element.querySelectorAll('input[type="number"], .fx-inspector-form__vec--angle input')].filter(input => {
        const style = getComputedStyle(input);
        textContext.font = style.font;
        const available = input.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
        return textContext.measureText(input.value).width > available;
      }).map(input => input.value);
      const rows = Object.fromEntries(['pos', 'quat', 'scale'].map(key => {
        const cells = [...element.querySelectorAll(`[data-testid="insp-field-Transform-${key}"] .fx-inspector-form__vcell`)];
        return [key, new Set(cells.map(cell => cell.getBoundingClientRect().top)).size];
      }));
      const card = element.querySelector('.insp-components-card');
      const tree = element.querySelector('.insp-component-browser');
      return { escaped, clippedValues, rows, cardHeight: card.getBoundingClientRect().height,
        treeHeight: tree.getBoundingClientRect().height, treeOverflow: getComputedStyle(tree).overflowY };
    });
    assert.deepEqual(geometry.escaped, [], `controls overflow at ${width}/${theme}`);
    assert.deepEqual(geometry.clippedValues, [], `values clipped at ${width}/${theme}`);
    assert.deepEqual(geometry.rows, { pos: 1, quat: 1, scale: 1 });
    for (const key of ['pos', 'quat', 'scale']) {
      const alignment = await panel.getByTestId(`insp-field-Transform-${key}`).evaluate(row => {
        const label = row.querySelector('.fx-property-row__label').getBoundingClientRect();
        return [...row.querySelectorAll('.fx-inspector-form__vcell')].every(cell => {
          const rect = cell.getBoundingClientRect();
          return rect.left >= label.right && Math.abs((rect.top + rect.bottom - label.top - label.bottom) / 2) < 2;
        });
      });
      assert.equal(alignment, true, `${key} label and XYZ must remain on one line at ${width}/${theme}`);
    }
    assert(geometry.cardHeight >= 160 && geometry.cardHeight <= 280);
    assert(geometry.treeHeight < geometry.cardHeight);
    assert.equal(geometry.treeOverflow, 'auto');
  }
  await panel.getByTestId('insp-search').fill('位置');
  assert.equal(await panel.locator('.insp-detail-section').count(), 1);
  assert.equal(await panel.getByTestId('insp-field-Transform-pos').count(), 1);
  await page.evaluate(() => globalThis.meshInspectorFixture.explicitGuids());
  await panel.getByTestId('insp-search').fill('');
  await panel.getByText('Painted Trim', { exact: true }).waitFor();
  await panel.getByTestId('insp-search').fill(' Painted Trim ');
  assert.equal(await panel.getByTestId('insp-material-slot-0').count(), 0);
  assert.equal(await panel.getByTestId('insp-material-slot-1').count(), 1);
  await panel.getByTestId('insp-search').fill('');
  await page.evaluate(() => globalThis.meshInspectorFixture.renameMesh());
  await panel.getByText('Updated Floor Mesh', { exact: true }).waitFor();
  await panel.getByTestId('insp-settings').click();
  await page.getByRole('menuitem', { name: '全部折叠', exact: true }).click();
  assert.equal(await panel.getByTestId('insp-section-Transform').locator('.fx-collapsible__trigger').getAttribute('aria-expanded'), 'false');
  assert.equal(await panel.getByTestId('insp-field-Transform-pos').isVisible(), false);
  await panel.getByTestId('insp-settings').click();
  await page.getByRole('menuitem', { name: '全部展开', exact: true }).click();
  await panel.getByTestId('insp-field-Transform-pos').waitFor();
  await panel.getByTestId('insp-group-rendering').click();
  assert.equal(await panel.getByTestId('insp-field-MeshRenderer-materials').count(), 0);
  await panel.getByTestId('insp-field-MeshRenderer-lightingChannels').waitFor();
  await panel.getByTestId('insp-group-all').click();
  await panel.getByTestId('insp-field-GlobalTransform-world').waitFor();
  await panel.getByTestId('insp-field-GlobalTransform-presentation').waitFor();
  await panel.getByTestId('insp-section-TransformInterpolation').waitFor();
  assert.equal(await panel.getByTestId('insp-field-MeshRenderer-materials').getByTestId('insp-material-slot-1').count(), 1);
  await panel.getByTestId('insp-search').fill('Painted Trim');
  assert.equal(await panel.getByTestId('insp-field-MeshRenderer-materials').getByTestId('insp-material-slot-0').count(), 0);
  assert.equal(await panel.getByTestId('insp-field-MeshRenderer-materials').getByTestId('insp-material-slot-1').count(), 1);
  await panel.getByTestId('insp-search').fill('');
  await panel.getByTestId('insp-field-CustomHealth-health').waitFor();
  await panel.getByTestId('insp-comprow-CustomHealth').getByText('CustomHealth', { exact: true }).waitFor();
  await panel.getByTestId('insp-section-CustomHealth').getByText('CustomHealth', { exact: true }).waitFor();
  const sceneSelectCalls = await page.evaluate(() => globalThis.meshInspectorFixture.calls.filter(call => call.operation === 'scene.select').length);
  const cardBeforeNavigation = await panel.getByTestId('insp-components-card').boundingBox();
  await panel.getByTestId('insp-search').fill('no matching property');
  await panel.getByTestId('insp-comprow-MeshFilter').click();
  assert.equal(await panel.getByTestId('insp-entity-body').getAttribute('data-group'), 'all');
  assert.equal(await panel.getByTestId('insp-search').inputValue(), '');
  assert.equal(await panel.getAttribute('data-entity-id'), 'floor');
  assert.equal(await panel.locator('.insp-detail-section').count(), 11);
  await page.waitForFunction(() => {
    const details = document.querySelector('[data-testid="insp-scroll"]');
    const section = document.querySelector('[data-testid="insp-section-MeshFilter"]');
    const viewport = details.getBoundingClientRect();
    const target = section.getBoundingClientRect();
    return details.scrollTop > 0 && target.top >= viewport.top - 2 && target.bottom <= viewport.bottom + 2;
  });
  assert.deepEqual(await panel.getByTestId('insp-components-card').boundingBox(), cardBeforeNavigation);
  assert.equal(await panel.getByTestId('insp-comprow-MeshFilter').getAttribute('aria-current'), 'location');
  await panel.getByTestId('insp-settings').click();
  await page.getByRole('menuitem', { name: '全部折叠', exact: true }).click();
  await panel.getByTestId('insp-comprow-TransformInterpolation').click();
  assert.equal(await panel.getByTestId('insp-section-TransformInterpolation').locator('.fx-collapsible__trigger').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => globalThis.meshInspectorFixture.calls.filter(call => call.operation === 'scene.select').length), sceneSelectCalls);
  await panel.getByTestId('insp-group-common').click();
  assert.equal(await panel.locator('.insp-detail-section').count(), 3);
  await panel.getByTestId('insp-settings').click();
  await page.getByRole('menuitem', { name: '全部展开', exact: true }).click();
  assert.equal(await panel.getByTestId('insp-field-Transform-pos').count(), 1);
  assert.equal(await panel.getByTestId('insp-component-list').locator('[aria-current]').count(), 0);
  await panel.getByTestId('insp-comprow-CustomHealth').click();
  await panel.getByTestId('insp-search').fill('health');
  await page.evaluate(() => globalThis.meshInspectorFixture.removeComponent('CustomHealth'));
  await panel.getByTestId('insp-comprow-CustomHealth').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('[data-testid="insp-entity-body"]')?.dataset.group === 'common');
  assert.equal(await panel.getByTestId('insp-search').inputValue(), '');
  assert.equal(await panel.getByTestId('insp-entity-body').getAttribute('data-group'), 'common');
  await page.evaluate(() => globalThis.meshInspectorFixture.restoreComponents());
  await panel.getByTestId('insp-settings').click();
  await page.getByRole('menuitem', { name: '全部展开', exact: true }).click();
  const entityCopyWrites = await page.evaluate(() => globalThis.meshInspectorFixture.clipboardWrites());
  await panel.getByRole('button', { name: '复制 JSON', exact: true }).click();
  const copied = JSON.parse(await page.evaluate(() => globalThis.meshInspectorFixture.copyText()));
  assert.deepEqual(copied.components.find(component => component.name === 'Transform').values.quat, [-0.2588190451, 0, 0, 0.9659258263]);
  assert.equal(await page.evaluate(() => globalThis.meshInspectorFixture.clipboardWrites()), entityCopyWrites + 1);
  await meshOpen().click();
  assert.equal(await panel.getAttribute('data-entity-id'), 'floor');
  const opened = await page.evaluate(() => globalThis.meshInspectorFixture.calls.find(call => call.operation === 'asset.open'));
  assert.equal(opened.args.guid, 'mesh-guid');
  assert.equal(opened.args.targetId, 'scene');
  assert.equal(opened.args.targetGeneration, 1);
  assert.equal(await panel.getByRole('treeitem', { name: 'Floor Trim', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => globalThis.meshInspectorFixture.sceneTreeRequests()), 0);
  await page.evaluate(() => globalThis.meshInspectorFixture.select('part'));
  await panel.locator('.insp-header-name').filter({ hasText: 'Floor Trim' }).waitFor();
  await page.evaluate(() => globalThis.meshInspectorFixture.select('floor'));
  await panel.locator('.insp-header-name').filter({ hasText: 'Farm Floor' }).waitFor();
  await page.evaluate(() => globalThis.meshInspectorFixture.fail('entity.focus'));
  await panel.getByRole('button', { name: '聚焦到对象', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'entity.focus unavailable' }).waitFor();
  await page.evaluate(() => globalThis.meshInspectorFixture.fail('entity.inspect'));
  await panel.getByText('实体检查不可用', { exact: true }).waitFor();
  await page.evaluate(() => globalThis.meshInspectorFixture.restoreTools());
  await panel.getByTestId('insp-entity-body').waitFor();
  await page.evaluate(() => globalThis.meshInspectorFixture.deferInspection());
  await page.waitForFunction(() => globalThis.meshInspectorFixture.inspectionPending());
  await page.evaluate(() => { globalThis.meshInspectorFixture.select('light'); globalThis.meshInspectorFixture.finishInspection(); });
  await page.waitForFunction(() => document.querySelector('[data-testid="panel-inspector"]').dataset.entityId === 'light');
  await page.waitForFunction(() => document.querySelector('[data-testid="insp-entity-body"]')?.dataset.entityKind === 'directionalLight');
  assert.equal(await page.getByTestId('insp-entity-body').count(), 1);
  await page.evaluate(() => globalThis.meshInspectorFixture.select('floor'));
  await panel.getByTestId('insp-comprow-MeshFilter').click();
  await page.evaluate(() => globalThis.meshInspectorFixture.replaceTarget());
  await page.getByTestId('insp-entity-body').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="insp-entity-body"]')?.dataset.group === 'common');
  assert.equal(await panel.getByTestId('insp-component-list').locator('[aria-current]').count(), 0);
  await panel.getByTestId('insp-comprow-MeshFilter').click();
  await page.evaluate(() => globalThis.meshInspectorFixture.replaceProject());
  await page.waitForFunction(() => document.querySelector('[data-testid="insp-entity-body"]')?.dataset.group === 'common');
  assert.equal(await panel.getByTestId('insp-component-list').locator('[aria-current]').count(), 0);
  assert.equal(await panel.getByTestId('insp-entity-body').getAttribute('data-group'), 'common');
  await page.evaluate(() => globalThis.meshInspectorFixture.missingBindings());
  await panel.getByText('资源绑定不可用', { exact: true }).waitFor();
  assert.equal(await meshOpen().isDisabled(), true);
  const kinds = ['entity', 'sceneInstance', 'mesh', 'skinnedMesh', 'instancedMesh', 'camera', 'directionalLight', 'pointLight', 'spotLight', 'areaLight', 'skylight', 'sky', 'fog', 'reflection', 'postProcess', 'physics', 'animation', 'audio', 'vfx', 'sprite', 'tilemap', 'text', 'geometry', 'decal', 'terrain', 'navigation', 'npc', 'video'];
  for (const theme of ['light', 'dark']) for (const width of [320, 480, 640]) {
    await page.setViewportSize({ width, height: 860 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const kind of kinds) {
      await page.evaluate(kind => globalThis.meshInspectorFixture.select(`case-${kind}`), kind);
      await page.waitForFunction(kind => document.querySelector('[data-testid="insp-entity-body"]')?.dataset.entityKind === kind, kind);
      const overflow = await panel.evaluate(element => [...element.querySelectorAll('button, input, .insp-color-channels, .insp-collection')].filter(control => control.getClientRects().length).filter(control => {
        const rect = control.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1;
      }).map(control => control.outerHTML));
      assert.deepEqual(overflow, [], `${kind} controls overflow at ${width}/${theme}`);
      const clipped = await panel.evaluate(element => {
        const context = new OffscreenCanvas(1, 1).getContext('2d');
        return [...element.querySelectorAll('input[type="number"]')].filter(input => {
          const style = getComputedStyle(input); context.font = style.font;
          return context.measureText(input.value).width > input.getBoundingClientRect().width
            - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
        }).map(input => input.value);
      });
      assert.deepEqual(clipped, [], `${kind} numeric values clipped at ${width}/${theme}`);
      for (const key of ['pos', 'quat', 'scale']) {
        assert.equal(await panel.getByTestId(`insp-field-Transform-${key}`).locator('.fx-inspector-form__vcell')
          .evaluateAll(cells => new Set(cells.map(cell => cell.getBoundingClientRect().top)).size), 1,
        `${kind}/${key} must keep XYZ on one row at ${width}/${theme}`);
      }
      assert.equal(await panel.locator('input:not([readonly]):not([disabled]):not([type="search"]), select:not([disabled]):not(.fx-inspector-form__color-mode)').count(), 0, `${kind} exposes an editable data field`);
      if (['sceneInstance', 'camera', 'directionalLight', 'animation', 'physics', 'audio', 'entity'].includes(kind)) await page.screenshot({ path: resolve(output, `${kind}-${theme}-${width}.png`) });
    }
  }
  await page.evaluate(() => globalThis.meshInspectorFixture.select('case-directionalLight'));
  const color = panel.getByTestId('insp-field-DirectionalLight-color');
  await color.waitFor();
  const beforeColorMode = await page.evaluate(() => globalThis.meshInspectorFixture.calls.filter(call => call.operation !== 'entity.inspect').length);
  await color.getByRole('combobox', { name: 'Color display mode' }).selectOption('linear');
  assert.match(await color.locator('.fx-inspector-form__color-hex').textContent(), /^rgba\(/);
  assert.equal(await page.evaluate(() => globalThis.meshInspectorFixture.calls.filter(call => call.operation !== 'entity.inspect').length), beforeColorMode);
  await page.evaluate(() => globalThis.meshInspectorFixture.select('world'));
  await page.waitForFunction(() => document.querySelector('[data-testid="insp-entity-body"]')?.dataset.entityKind === 'sceneInstance');
  assert.equal(await panel.locator('.insp-detail-section').count(), 2);
  assert.equal(await panel.getByTestId('insp-section-mesh').count(), 0);
  await panel.getByTestId('insp-field-SceneInstance-mapping').locator('summary').click();
  assert.equal(await panel.getByTestId('insp-field-SceneInstance-mapping').locator('dd').count(), 3);
  await page.evaluate(() => globalThis.meshInspectorFixture.select('case-animation'));
  await panel.getByTestId('insp-group-animation').waitFor();
  await panel.getByTestId('insp-group-animation').click();
  await panel.getByTestId('insp-field-MorphWeights-weights').getByText('部分数据：已返回 128 项', { exact: true }).waitFor();
  await panel.getByTestId('insp-field-MorphWeights-weights').locator('summary').click();
  assert.equal(await panel.getByTestId('insp-field-MorphWeights-weights').locator('dd').count(), 16);
  await panel.getByTestId('insp-field-MorphWeights-weights').getByRole('button', { name: '显示已返回的 128 项', exact: true }).click();
  assert.equal(await panel.getByTestId('insp-field-MorphWeights-weights').locator('dd').count(), 128);
  await page.evaluate(() => globalThis.meshInspectorFixture.select('bare'));
  await page.waitForFunction(() => document.querySelector('[data-testid="insp-entity-body"]')?.dataset.group === 'object');
  assert.equal(await panel.getByTestId('insp-group-common').count(), 0);
  await page.evaluate(() => globalThis.meshInspectorFixture.select('case-camera', ['case-camera', 'floor']));
  await panel.locator('.insp-selection-count').getByText('已选 2 项 · 主对象', { exact: true }).waitFor();
  await panel.getByTestId('insp-group-rendering').click();
  await panel.getByTestId('insp-section-Camera.exposure').waitFor();
  await panel.getByTestId('insp-section-Camera.antialiasing').waitFor();
  await panel.getByTestId('insp-section-Camera.bloom').waitFor();
  await panel.getByTestId('insp-section-Camera.cameraOutput').waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, evidence: 'Chromium UI with deterministic API responses; no Engine/GPU', screenshots: output }));
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
  await rm(temporary, { recursive: true, force: true });
}
