import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../../..');
const output = resolve(root, 'artifacts/water-r0/browser');
mkdirSync(output, { recursive: true });
const launch = JSON.parse(readFileSync(resolve(root, 'scripts/ci/browser-launch.json'), 'utf8'));
const browser = await chromium.launch({ ...launch, headless: true, chromiumSandbox: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:5178/water-r0.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.dataset.waterBodies === '4', undefined, { timeout: 120_000 });

  const selector = '#body-actors [data-action="toggle"][data-kind="river"]';
  const button = await page.locator(selector).elementHandle();
  assert(button, 'River unload button must be present');
  const stillSameButton = () => button.evaluate((element) => element.isConnected && document.querySelector('#body-actors [data-action="toggle"][data-kind="river"]') === element);
  assert.equal(await stillSameButton(), true);
  const idleMutations = await page.evaluate(async () => {
    const target = document.querySelector('#body-actors');
    if (!target) throw new Error('Missing WaterBody actor panel');
    const observer = new MutationObserver(() => undefined);
    observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
    await new Promise((resolve) => setTimeout(resolve, 650));
    const records = observer.takeRecords();
    observer.disconnect();
    return { childList: records.filter((record) => record.type === 'childList').length, characterData: records.filter((record) => record.type === 'characterData').length, attributes: records.filter((record) => record.type === 'attributes').length };
  });
  assert.deepEqual(idleMutations, { childList: 0, characterData: 0, attributes: 0 }, 'Stable panel refreshes must cause no DOM mutations');

  const bounds = await button.boundingBox();
  assert(bounds, 'River unload button must have visible bounds');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(350);
  assert.equal(await stillSameButton(), true, 'Panel refresh must preserve the pressed button across timer ticks');
  await page.mouse.up();

  await page.waitForFunction(() => document.body.dataset.waterBodies === '3', undefined, { timeout: 5000 });
  await page.waitForTimeout(250);
  assert.equal(await stillSameButton(), true, 'Panel refresh must preserve the button after unloading');
  assert.equal(await page.locator(selector).textContent(), '挂载实例');
  assert.deepEqual(errors, []);
  await page.locator('#toggle-panels').click();
  const panelsHidden = await page.evaluate(() => document.body.classList.contains('panel-hidden') && getComputedStyle(document.querySelector('aside')).display === 'none' && getComputedStyle(document.querySelector('.body-panel')).display === 'none');
  assert.equal(panelsHidden, true, 'Interaction evidence screenshot must hide all panels');
  await page.screenshot({ path: resolve(output, 'interaction-river-unloaded.png') });
  console.log(JSON.stringify({ url: page.url(), interaction: 'pointerdown held across 3+ panel refreshes, pointerup dispatched click', bodyCount: 3, riverButtonRemainedSameElement: true, stablePanelMutationsAcross650ms: idleMutations, panelsHidden, screenshot: 'interaction-river-unloaded.png', errors }));
} finally {
  await browser.close();
}
