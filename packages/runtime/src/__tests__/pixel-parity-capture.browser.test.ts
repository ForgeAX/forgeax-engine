import { PointLight } from '@forgeax/engine-render';
import { expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { RendererHostAssembly } from '../renderer-host';

// Observe the actual fixture's hosts solely to retire their native resources.
const hosts = vi.hoisted(() => [] as RendererHostAssembly[]);
vi.mock('@forgeax/engine-runtime/internal/renderer-host', async (original) => {
  const runtime = await original<typeof import('../renderer-host')>();
  return {
    ...runtime,
    async constructRuntimeRendererHost(
      ...args: Parameters<typeof runtime.constructRuntimeRendererHost>
    ) {
      const result = await runtime.constructRuntimeRendererHost(...args);
      if (result.ok) hosts.push(result.value);
      return result;
    },
  };
});

it('captures nonempty equal Standard scenes after native canvas presentation', async () => {
  const originalBody = [...document.body.childNodes];
  const left = document.createElement('canvas');
  const right = document.createElement('canvas');
  left.id = 'direct';
  right.id = 'clustered';
  document.body.replaceChildren(left, right);
  delete window.__captureLeft;
  delete window.__captureRight;
  const disposalFailures: unknown[] = [];
  try {
    const { bootstrapReady } = await import('../../../../apps/parity/urp-vs-hdrp/src/main');
    // The fixture completes its initial submissions before capture or disposal.
    const fixture = await bootstrapReady;
    const captureLeft = window.__captureLeft;
    const captureRight = window.__captureRight;
    if (captureLeft === undefined || captureRight === undefined)
      throw new Error('Standard parity capture hooks were not installed');
    const a = await captureLeft();
    // Force real compositor observation between the two receipt-bound captures.
    await page.elementLocator(left).screenshot({ save: false });
    const b = await captureRight();
    expect(a.length).toBe(512 * 512 * 4);
    expect(b.length).toBe(a.length);
    for (const pixels of [a, b]) {
      const lit = pixels.reduce(
        (count, value, index) => count + Number(index % 4 !== 3 && value > 0),
        0,
      );
      expect(lit).toBeGreaterThan(10_000);
      expect(
        pixels.filter((value, index) => index % 4 === 3 && value === 255).length,
      ).toBeGreaterThan(10_000);
    }
    const maximum = a.reduce(
      (delta, value, index) => Math.max(delta, Math.abs(value - (b[index] ?? NaN))),
      0,
    );
    expect(maximum / 255).toBeLessThanOrEqual(0.001);
    // Equal empty pictures are not lighting parity. Change real light data,
    // require different completed pixels, then restore the original picture.
    const { world, lights } = fixture.clustered;
    const intensities = lights.map((light) => ({
      light,
      intensity: world.get(light, PointLight).unwrap().intensity,
    }));
    for (const light of lights) world.set(light, PointLight, { intensity: 0 }).unwrap();
    const unlit = await captureRight();
    expect(unlit.some((value, index) => value !== b[index])).toBe(true);
    for (const { light, intensity } of intensities)
      world.set(light, PointLight, { intensity }).unwrap();
    const restored = await captureRight();
    expect(restored).toEqual(b);
  } finally {
    const disposed = await Promise.allSettled(
      hosts.map(async (host) => {
        const result = await host.renderer.dispose();
        host.assets.dispose();
        return result;
      }),
    );
    for (const result of disposed) {
      if (result.status === 'rejected') disposalFailures.push(result.reason);
      else if (!result.value.ok) disposalFailures.push(result.value.error);
    }
    hosts.length = 0;
    delete window.__captureLeft;
    delete window.__captureRight;
    document.body.replaceChildren(...originalBody);
  }
  expect(disposalFailures).toEqual([]);
}, 90_000);
