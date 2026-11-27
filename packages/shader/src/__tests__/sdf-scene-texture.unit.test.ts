import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/index';
import { SDF_SCENE_TEXTURE_LAYOUT, SDF_SCENE_TEXTURE_READ_WGSL } from '../sdf-scene-texture-wgsl';
import { SDF_SURFACE_POOL_LAYOUT } from '../sdf-surface-pool-wgsl';
import {
  boundSceneTextureReaderKernel,
  sceneTextureCases,
  sceneTextureExpected,
  sceneTextureInitializationExpected,
  sceneTextureInitializationKernel,
  sceneTextureReaderVariants,
} from './sdf-scene-texture.fixture';
import { surfacePoolCases } from './sdf-surface-pool.fixture';

it('derives the canonical instance stride while keeping the transport header separate', () => {
  expect(SDF_SCENE_TEXTURE_LAYOUT).toEqual({
    magic: 0x46585354,
    version: 1,
    headerWords: 16,
    instanceWords: 36,
  });
  expect(SDF_SCENE_TEXTURE_LAYOUT.instanceWords).toBe(SDF_SURFACE_POOL_LAYOUT.instanceWords);
  expect(SDF_SCENE_TEXTURE_READ_WGSL).not.toMatch(/@binding|@group|bitcast<f32>|var<storage/);
  // The explicit initializer is declared once and never called by a word fetch.
  expect(SDF_SCENE_TEXTURE_READ_WGSL.split('sdfSceneView()')).toHaveLength(2);
});
it('compiles a real pre-initialization word-read counterexample without changing the source tuple', async () => {
  const rows = sceneTextureCases(),
    expected = sceneTextureInitializationExpected(rows);
  expect(expected).toHaveLength(33 * 24);
  for (const index of rows.keys())
    expect(Array.from(expected.subarray(index * 24, index * 24 + 8))).toEqual(new Array(8).fill(0));
  const source = sceneTextureInitializationKernel();
  const compiled = await compileShader(source, { id: 'scene-reader-explicit-initialization' });
  expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
  if (compiled.ok && process.env.FORGEAX_SCENE_TEXTURE_INIT_CPU_OUTPUT) {
    const directory = process.env.FORGEAX_SCENE_TEXTURE_INIT_CPU_OUTPUT;
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/compiled.wgsl`, compiled.value.wgsl);
    writeFileSync(
      `${directory}/cases.json`,
      JSON.stringify(
        rows.map((row) => ({
          ...row,
          words: Array.from(row.words),
          source: Array.from(row.source),
        })),
        null,
        2,
      ),
    );
  }
});
it('keeps high-water, allocation, padding, epoch and paired-address counterexamples distinct', () => {
  const rows = sceneTextureCases();
  expect(rows).toHaveLength(33);
  expect(new Set(rows.map((row) => row.name)).size).toBe(33);
  expect(rows.filter((row) => row.expected[0] === 1)).toHaveLength(5);
  expect(
    rows
      .find((row) => row.name === 'raw-capacity-is-not-candidate-highwater')
      ?.expected.slice(0, 4),
  ).toEqual([1, 2, 1, 89]);
  expect(
    rows.find((row) => row.name === 'self-consistent-header-lies-about-field-padding')?.words[12],
  ).toBe(192);
  expect(sceneTextureExpected(rows)).toHaveLength(33 * 24);
});
it('compiles the real binding-free reader with the existing packet decoder and wrong controls', async () => {
  const variants = sceneTextureReaderVariants();
  expect(new Set(variants.map((row) => row.source)).size).toBe(4);
  for (const row of variants) {
    const compiled = await compileShader(row.source, { id: `scene-reader-${row.name}` });
    expect(compiled.ok, row.name).toBe(true);
  }
});
it('compiles the shared projection-uniform consumer without treating shape words as receiver selection', async () => {
  const source = boundSceneTextureReaderKernel();
  expect(source).not.toContain('readerSettings.selected.');
  expect((await compileShader(source, { id: 'scene-reader-bound-uniform' })).ok).toBe(true);
});

it('transports the complete V4 packet without rewriting its row-owned coverage record', () => {
  const packet = surfacePoolCases()[0];
  if (!packet) throw Error('Authored metadata packet missing');
  const row = sceneTextureCases()[0];
  if (!row) throw Error('Authored transport case missing');
  expect(Array.from(row.source)).toEqual([72, 89, 1, 7]);
  expect(Array.from(row.words.subarray(4, 8))).toEqual([16, 72, 88, 89]);
  expect(row.words[12]).toBe(177);
  expect(177).toBeLessThanOrEqual(row.width * row.height * 4);
  expect(row.words.subarray(88, 177)).toEqual(packet.fields);
  expect(Array.from(row.words.subarray(132, 136))).toEqual([0, 1, 0, 0]);
  expect(Array.from(row.words.subarray(136, 140))).toEqual([1, 1, 0, 0]);
  expect(row.words[176]).toBe(0xffffffff);
  expect(row.words[177]).toBe(0xdeadbeef);
  expect(row.expected.slice(0, 4)).toEqual([1, 2, 1, 89]);
  expect(row.expected.slice(12, 15)).toEqual([1, 52, 88]);
  const edited = row.words.slice();
  edited[88 + 52] = 0x80000001;
  expect(edited[140]).toBe(0x80000001);
  expect(Array.from(edited.subarray(132, 140))).toEqual([0, 1, 0, 0, 1, 1, 0, 0]);
});
