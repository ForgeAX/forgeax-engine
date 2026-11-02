import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCapture } from '@forgeax/engine-modeling/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TS_KERNEL_DIGEST } from '../compute/kernel-digest';
import { distDigest } from '../tools/build-identity';

const root = fileURLToPath(new URL('../../', import.meta.url));
let directory = '';

const PACK = `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a5e1'),
  parameters: [{ name: 'height', type: 'f32', default: 1, minimum: 0.1, maximum: 4 }],
  build({ values }) {
    const m = model();
    m.box({ size: [1, values.height, 1], tag: 'shell' });
    m.subdivide(sel.all(), { levels: 3 });
    m.uv.project({ mode: 'box', scale: 1 });
    return m.finish({ key: 'crate' });
  },
});
`;

beforeAll(async () => {
  directory = await mkdtemp(join(root, '.isolation-timing-'));
  await writeFile(join(directory, 'crate.pack.ts'), PACK);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('capture timing runs', () => {
  it('reports cold, hot, local and final next to the environment record', {
    timeout: 120000,
  }, async () => {
    const sourcePath = join(directory, 'crate.pack.ts');
    const result = await runCapture({ sourcePath, timingRuns: { local: { height: 2 } } });
    if (!result.ok) throw new Error(result.error.code);
    const { timing } = result.value;
    for (const field of ['cold', 'hot', 'local', 'final'] as const) {
      expect(timing[field], field).toBeGreaterThan(0);
    }
    expect(timing.cold).toBe(timing.buildMs);
    expect(timing.hot as number).toBeLessThan(timing.cold as number);
    expect(timing.env).toEqual({
      distDigest: distDigest(fileURLToPath(new URL('../../dist/', import.meta.url))),
      kernelSha: TS_KERNEL_DIGEST,
    });
    expect(result.value.sessions).toHaveLength(1);
  });

  it('adds nothing without timingRuns, and skips local runs without an edit', {
    timeout: 120000,
  }, async () => {
    const sourcePath = join(directory, 'crate.pack.ts');
    const plain = await runCapture({ sourcePath });
    if (!plain.ok) throw new Error(plain.error.code);
    expect(Object.keys(plain.value.timing).sort()).toEqual([
      'buildMs',
      'loadMs',
      'summarizeMs',
      'targetMs',
      'totalMs',
      'validateMs',
    ]);
    const hotOnly = await runCapture({ sourcePath, timingRuns: {} });
    if (!hotOnly.ok) throw new Error(hotOnly.error.code);
    expect(hotOnly.value.timing.hot).toBeGreaterThan(0);
    expect(hotOnly.value.timing.local).toBeUndefined();
    expect(hotOnly.value.timing.final).toBeUndefined();
  });

  it('fails on an edit naming an undeclared parameter', {
    timeout: 120000,
  }, async () => {
    const bad = await runCapture({
      sourcePath: join(directory, 'crate.pack.ts'),
      timingRuns: { local: { bogus: 1 } },
    });
    expect(bad.ok).toBe(false);
  });
});

describe('distDigest', () => {
  it('changes with any runtime file and ignores maps and declarations', async () => {
    const dir = await mkdtemp(join(root, '.isolation-dist-'));
    try {
      await mkdir(join(dir, 'tools'));
      await writeFile(join(dir, 'index.mjs'), 'export const a = 1;\n');
      await writeFile(join(dir, 'tools', 'w.mjs'), 'export const b = 2;\n');
      const base = distDigest(dir);
      expect(base).toMatch(/^[0-9a-f]{16}$/);
      expect(distDigest(dir)).toBe(base);
      await writeFile(join(dir, 'index.d.ts'), 'declare const a: 1;\n');
      await writeFile(join(dir, 'index.mjs.map'), '{}');
      expect(distDigest(dir)).toBe(base);
      await writeFile(join(dir, 'tools', 'w.mjs'), 'export const b = 3;\n');
      expect(distDigest(dir)).not.toBe(base);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
