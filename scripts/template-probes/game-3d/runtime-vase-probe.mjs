import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Wait for the submitted prefix associated with the consumed generated asset. */
export async function waitForRuntimeVaseRender(page) {
  const before = await page.evaluate(
    () => document.querySelector('canvas')?.forgeaxFrameProgress?.submitted?.frameId ?? 0,
  );
  await page.waitForFunction(
    (previousFrameId) => {
      const completed = document.querySelector('canvas')?.forgeaxFrameProgress?.completed;
      return (
        (completed?.frameId ?? 0) >= previousFrameId + 2 && completed?.presentation === 'ready'
      );
    },
    before,
    { timeout: 60_000 },
  );
}

/** Shared by Preview and the generated DevKit project's main/Worker browser gates. */
export async function probeRuntimeVase(
  page,
  read,
  evidenceDir,
  capture = (options) => page.screenshot(options),
) {
  const button = page.getByRole('button', { name: 'Reshape vase' });
  await button.waitFor({ timeout: 120_000 });
  const wait = async (predicate) => {
    let latest;
    for (let attempt = 0; attempt < 300; attempt++) {
      latest = await read();
      if (predicate(latest)) return latest;
      await page.waitForTimeout(100);
    }
    throw new Error(`runtime vase did not settle: ${JSON.stringify(latest)}`);
  };
  const initial = await wait((state) => state?.generation !== undefined && !state.busy);
  assert.equal(initial.error, undefined);
  await page.evaluate(() => {
    if (globalThis.__forgeaxVaseReadiness)
      globalThis.__forgeaxVaseReadiness.loadingWaitStartedAtMs = performance.now();
  });
  await page.locator('#forgeax-loading').waitFor({ state: 'hidden', timeout: 60_000 });
  await mkdir(evidenceDir, { recursive: true });
  await waitForRuntimeVaseRender(page);
  await capture({ path: join(evidenceDir, 'vase-initial.png') });
  // The button posts the next preset (height 3.4) over the host port; the engine regenerates in place.
  await button.click();
  const updated = await wait((state) => !state.busy && state.generation !== initial.generation);
  assert.equal(updated.error, undefined);
  assert.equal(updated.guid, initial.guid);
  assert.equal(updated.entity, initial.entity);
  assert.ok(Math.abs(updated.aabb[4] - 3.4) < 0.001);
  await waitForRuntimeVaseRender(page);
  await capture({ path: join(evidenceDir, 'vase-updated.png') });
  return { initial, updated };
}
