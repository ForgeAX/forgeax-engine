import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { scanInventory } from '../scanner.js';

const loading = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../scriptable-pack-node.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scriptable-pack-node.js')>()),
  loadScriptablePack: loading.load,
}));

it.each([
  'success',
  'failure',
] as const)('bounds metadata work, keeps source order and settles siblings on %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-scan-batches-'));
  const paths = Array.from({ length: 6 }, (_, i) => join(root, `${i}.pack.ts`));
  await Promise.all(paths.map((path) => writeFile(path, 'export default {};')));
  const releases: (() => void)[] = [];
  let cleaning = false;
  let active = 0;
  let peak = 0;
  let finished = false;
  loading.load.mockImplementation(async (path: string) => {
    const index = paths.indexOf(path);
    active++;
    peak = Math.max(peak, active);
    if (!cleaning)
      await new Promise<void>((resolve) => {
        releases[index] = resolve;
      });
    active--;
    if (mode === 'failure' && index === 0)
      return {
        ok: false,
        error: {
          code: 'pack-parameter-invalid',
          detail: { diagnostic: 'injected loader failure' },
        },
      };
    const packageId = new Uint8Array(16);
    packageId[15] = index + 1;
    return {
      ok: true,
      value: {
        schemaVersion: '2.0.0',
        packageId,
        build() {
          throw new Error('metadata must not build');
        },
      },
    };
  });
  const scan = scanInventory(paths, { scriptablePack: { metadataOnly: true } });
  void scan.finally(() => {
    finished = true;
  });
  try {
    await vi.waitFor(() => expect(releases.filter(Boolean)).toHaveLength(4));
    releases[0]?.();
    await vi.waitFor(() => expect(active).toBe(3));
    expect(finished).toBe(false);
    expect(loading.load).toHaveBeenCalledTimes(4);
    for (const index of [3, 2, 1]) releases[index]?.();
    if (mode === 'success') {
      await vi.waitFor(() => expect(releases.filter(Boolean)).toHaveLength(6));
      releases[5]?.();
      releases[4]?.();
    }
    const result = await scan;
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(result.ok).toBe(mode === 'success');
    if (result.ok) expect([...result.value.declarations.keys()]).toEqual(paths);
    else expect(result.error).toMatchObject({ detail: { path: paths[0] } });
    expect(loading.load).toHaveBeenCalledTimes(mode === 'success' ? 6 : 4);
  } finally {
    cleaning = true;
    for (const release of releases) release?.();
    await scan;
    loading.load.mockReset();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  false,
  true,
])('keeps build leases or a caller executor serial (custom=%s)', async (custom) => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-scan-leases-'));
  const paths = Array.from({ length: 6 }, (_, i) => join(root, `${i}.pack.ts`));
  await Promise.all(paths.map((path) => writeFile(path, 'export default {};')));
  let active = 0;
  let peak = 0;
  loading.load.mockImplementation(async (path: string) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    const packageId = new Uint8Array(16);
    packageId[15] = paths.indexOf(path) + 1;
    return { ok: true, value: { schemaVersion: '2.0.0', packageId, build() {} } };
  });
  try {
    const result = await scanInventory(
      paths,
      custom ? { scriptablePack: { metadataOnly: true, executor: { async load() {} } } } : {},
    );
    expect(result.ok).toBe(true);
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(loading.load).toHaveBeenCalledTimes(6);
  } finally {
    loading.load.mockReset();
    await rm(root, { recursive: true, force: true });
  }
});
