import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Shared by Preview and the generated DevKit project's main/Worker browser gates. */
export async function probeRuntimeVase(page, read, evidenceDir, capture = options => page.screenshot(options)) {
  const settleRender = async () => {
    const before = await page.evaluate(() => Number(document.documentElement.dataset.forgeaxFrameSubmitted ?? 0));
    await page.waitForFunction(frame => Number(document.documentElement.dataset.forgeaxFrameSubmitted ?? 0) >= frame + 2,
      before, { timeout: 60_000 });
  };
  const panel = page.getByRole('region', { name: 'Runtime vase' });
  await panel.waitFor({ timeout: 120_000 });
  const status = panel.locator('[data-ui-part="vase-status"]');
  const wait = async (predicate) => {
    let latest;
    for (let attempt = 0; attempt < 300; attempt++) {
      latest = await read();
      if (predicate(latest)) return latest;
      await page.waitForTimeout(100);
    }
    throw new Error(`runtime vase did not settle: ${JSON.stringify(latest)}`);
  };
  const initial = await wait(state => state?.generation !== undefined && !state.busy);
  assert.equal(initial.error, undefined);
  await page.evaluate(() => {
    if (globalThis.__forgeaxVaseReadiness)
      globalThis.__forgeaxVaseReadiness.loadingWaitStartedAtMs = performance.now();
  });
  await page.locator('#forgeax-loading').waitFor({ state: 'hidden', timeout: 60_000 });
  await mkdir(evidenceDir, { recursive: true });
  await settleRender();
  await capture({ path: join(evidenceDir, 'vase-initial.png') });
  await panel.getByLabel('Height', { exact: true }).fill('3.5');
  await panel.getByLabel('Radius', { exact: true }).fill('1.1');
  await panel.getByLabel('Sides', { exact: true }).fill('16');
  await panel.getByRole('button', { name: 'Generate vase' }).click();
  const updated = await wait(state => !state.busy && state.generation !== initial.generation);
  assert.equal(updated.error, undefined);
  assert.equal(updated.guid, initial.guid);
  assert.equal(updated.entity, initial.entity);
  assert.ok(Math.abs(updated.aabb[4] - 3.5) < 0.001);
  assert.ok(updated.vertexCount < initial.vertexCount);
  await settleRender();
  await capture({ path: join(evidenceDir, 'vase-updated.png') });
  // Bypass HTML's minimum solely to prove the producer rejects invalid input.
  const height = panel.getByLabel('Height', { exact: true });
  await height.evaluate(input => { input.min = '0'; });
  await height.fill('0');
  await panel.getByRole('button', { name: 'Generate vase' }).click();
  const rejected = await wait(state => !state.busy && !!state.error);
  assert.equal(rejected.generation, updated.generation);
  assert.equal(rejected.entity, initial.entity);
  assert.deepEqual(rejected.aabb, updated.aabb);
  // Inspection can precede the MessagePort delivery to the Host UI.
  await status.filter({ hasText: /Previous vase kept/ }).waitFor({ timeout: 30_000 });
  await height.evaluate(input => { input.min = '1'; });
  await height.fill('2.4');
  await panel.getByRole('button', { name: 'Generate vase' }).click();
  const recovered = await wait(state => !state.busy && !state.error);
  assert.equal(recovered.guid, initial.guid);
  assert.equal(recovered.entity, initial.entity);
  assert.ok(Math.abs(recovered.aabb[4] - 2.4) < 0.001);
  return { initial, updated, rejected, recovered };
}
