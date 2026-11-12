import { createHash } from 'node:crypto';
import type { NativeCookDraft } from '@forgeax/engine-pack/native-cooker';
import { DEFAULT_STANDARD_SURFACE_MODULE } from '@forgeax/engine-shader';
import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { programAffinityKey, selectAffineJob } from '../node-material-cooker.js';
import { createMaterialPackCooker } from '../pack-cooker.js';

afterEach(() => vi.unstubAllEnvs());

describe('material pool program affinity', () => {
  const lane = { name: 'a' };
  const other = { name: 'b' };
  const job = (program: string) => ({ program });

  it('gives a lane its own programs first, then unheld programs, never programs another lane holds', () => {
    const affinity = new Map<string, object>([
      ['standard', other],
      ['glass', lane],
    ]);
    const queue = [job('standard'), job('decal'), job('glass'), job('standard')];
    expect(selectAffineJob(queue, lane, affinity)).toBe(2);
    expect(selectAffineJob(queue.slice(0, 2), lane, affinity)).toBe(1);
    // A program held by a busy lane waits for it instead of composing again elsewhere.
    expect(selectAffineJob([job('standard')], lane, affinity)).toBe(-1);
    expect(selectAffineJob([job('standard')], other, affinity)).toBe(0);
  });
});

describe('material pool routing key', () => {
  it('hashes program content only: not names, values or key insertion order', () => {
    const roots = ['/project/assets'];
    const key = (input: unknown) => programAffinityKey(roots, undefined, input);
    const base = {
      guid: 'a',
      sourceKey: 'material/a',
      sourcePath: '/project/assets/a.pack.ts',
      source: { kind: 'material', passes: [{ name: 'forward' }], values: { roughness: 0.1 } },
    };
    const reordered = {
      sourcePath: '/project/assets/b.pack.ts',
      sourceKey: 'material/b',
      guid: 'b',
      source: { values: { roughness: 0.9 }, passes: [{ name: 'forward' }], kind: 'material' },
    };
    expect(key(reordered)).toBe(key(base));
    expect(key(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(key({ ...base, source: { ...base.source, passes: [{ name: 'deferred' }] } })).not.toBe(
      key(base),
    );
    expect(key({ ...base, sourcePath: '/other/a.pack.ts' })).not.toBe(key(base));
    expect(programAffinityKey(roots, 'webgpu-storage', base)).not.toBe(key(base));
  });
});

function standard(names: readonly string[], roughness: number): MaterialAsset {
  return {
    kind: 'material',
    parameters: standardSurfaceParameters(
      names.map((name) => ({ name, type: name === 'baseColor' ? 'color' : 'f32' }) as const),
    ),
    passes: [
      {
        name: 'forward',
        program: {
          module: 'forgeax_material::standard',
          fragmentEntry: 'fs_main',
          moduleSlots: { surface: DEFAULT_STANDARD_SURFACE_MODULE },
        },
      },
    ],
    values: { roughness },
  };
}

/** Whole-draft identity, with artifact bytes hashed rather than enumerated. */
function digest(draft: NativeCookDraft): string {
  return JSON.stringify(draft, (_key, value) =>
    value instanceof Uint8Array ? createHash('sha256').update(value).digest('hex') : value,
  );
}

it('publishes byte-identical drafts from the Worker pool and the serial cooker', async () => {
  // Two contracts, interleaved, with distinct values: repeats reuse their program.
  const inputs = [0.1, 0.2, 0.3, 0.4].map((roughness, index) => ({
    guid: `pool-material-${index}`,
    source: standard(
      index % 2 === 0 ? ['baseColor', 'roughness'] : ['baseColor', 'roughness', 'metallic'],
      roughness,
    ),
  }));
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1');
  const serialCooker = createMaterialPackCooker();
  const serial = [];
  for (const input of inputs) serial.push(await serialCooker.cook(input));
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '2');
  const pooledCooker = createMaterialPackCooker();
  const pooled = await Promise.all(inputs.map((input) => pooledCooker.cook(input)));
  expect(pooled.map(digest)).toEqual(serial.map(digest));
  expect(pooled.map((draft) => draft.guid)).toEqual(inputs.map((input) => input.guid));
}, 120_000);
