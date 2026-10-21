import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it.each([
  false,
  true,
])('keeps new module owners distinct when crypto is absent=%s', async (withoutCrypto) => {
  if (withoutCrypto) vi.stubGlobal('crypto', undefined);
  vi.resetModules();
  const first = await import('../world');
  const world = new first.World();
  const identity = world.identity;
  world.spawn().unwrap();
  expect(world.identity).toBe(identity);
  expect(new first.World().identity).not.toBe(identity);

  // A new module copy starts its local counter again, as a replacement Worker does.
  vi.resetModules();
  const replacement = await import('../world');
  expect(new replacement.World().identity).not.toBe(identity);
});
