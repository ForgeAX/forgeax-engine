import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { shaderSourceDigestInput } from '@forgeax/engine-shader';
import { beforeEach, expect, it, vi } from 'vitest';
import { encodePackagedProfiles } from '../engine-inputs/packaged-profiles.js';

const files = vi.hoisted(() => ({
  manifest: '',
  imports: '',
  sourceDigest: 'current',
  container: undefined as Buffer | undefined,
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: () => true,
  readFileSync: () =>
    files.container ??
    encodePackagedProfiles({
      shaderSourceDigest: 'current',
      imports: JSON.parse(files.imports),
      publications: { 'base-ssao': JSON.parse(files.manifest) },
    }),
}));
vi.mock('../engine-inputs/source-digest.js', () => ({
  engineShaderSourceDigest: () => files.sourceDigest,
}));

beforeEach(() => {
  vi.resetModules();
  files.sourceDigest = 'current';
  files.container = undefined;
  files.imports = JSON.stringify({
    'forgeax_material::slot::surface': 'surface source',
  });
  const source = 'fn main() {}';
  const digest = createHash('sha256')
    .update(shaderSourceDigestInput([createHash('sha256').update(source).digest()]))
    .digest('hex');
  files.manifest = JSON.stringify({
    schemaVersion: '5.0.0',
    receipts: [],
    entryPoints: [],
    fragments: [source],
    sources: { [digest]: [0] },
    entries: [{ hash: 'engine', sourceDigest: digest, bindings: '[]' }],
    materialShaders: ['forgeax::default-standard-pbr', 'forgeax::default-unlit'].map(
      (identifier) => ({ identifier, sourceDigest: digest, variants: [] }),
    ),
  });
});

it('shares verified immutable shader rows across servers and SSAO projections', async () => {
  const { loadPackagedEngineShaderInputs } = await import('../shared-engine-inputs.js');
  const first = loadPackagedEngineShaderInputs(false, true);
  const next = loadPackagedEngineShaderInputs(false, false);
  expect(first).not.toBeNull();
  expect(next?.materialShaders).toBe(first?.materialShaders);
  expect(next?.imports).toBe(first?.imports);
  expect(next?.entries).toEqual(first?.entries);
});

it('replaces changed publication and import bytes instead of trusting the path', async () => {
  const { loadPackagedEngineShaderInputs } = await import('../shared-engine-inputs.js');
  const first = loadPackagedEngineShaderInputs(false, true);
  const manifest = JSON.parse(files.manifest);
  manifest.entries[0].hash = 'updated';
  files.manifest = JSON.stringify(manifest);
  const changed = loadPackagedEngineShaderInputs(false, true);
  expect(changed?.entries[0]?.hash).toBe('updated');
  expect(changed?.materialShaders).not.toBe(first?.materialShaders);
  files.imports = JSON.stringify({
    'forgeax_material::slot::surface': 'updated surface source',
  });
  expect(loadPackagedEngineShaderInputs(false, true)?.imports).toEqual(JSON.parse(files.imports));
  expect(first?.entries[0]?.hash).toBe('engine');
});

it('still rejects changed corrupt source bytes and stale engine provenance after reuse', async () => {
  const { loadPackagedEngineShaderInputs } = await import('../shared-engine-inputs.js');
  const first = loadPackagedEngineShaderInputs(false, true);
  const original = files.manifest;
  const manifest = JSON.parse(original);
  manifest.fragments[0] = 'corrupt';
  files.manifest = JSON.stringify(manifest);
  expect(() => loadPackagedEngineShaderInputs(false, true)).toThrow('source digest mismatch');
  files.manifest = original;
  expect(loadPackagedEngineShaderInputs(false, true)?.materialShaders).toBe(first?.materialShaders);
  files.sourceDigest = 'changed engine';
  expect(loadPackagedEngineShaderInputs(false, true)).toBeNull();
});

it('rebuilds an obsolete transport even when its WGSL provenance still matches', async () => {
  const { loadPackagedEngineShaderInputs } = await import('../shared-engine-inputs.js');
  expect(loadPackagedEngineShaderInputs(false, true)).not.toBeNull();
  const obsolete = JSON.parse(files.manifest);
  obsolete.schemaVersion = '2.0.0';
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    for (const stale of [obsolete, { ...JSON.parse(files.manifest), receipts: {} }]) {
      files.manifest = JSON.stringify(stale);
      expect(loadPackagedEngineShaderInputs(false, true)).toBeNull();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('publication version'));
    }
    files.container = gzipSync(JSON.stringify({ schemaVersion: 0 }));
    expect(loadPackagedEngineShaderInputs(false, true)).toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('container version'));
  } finally {
    warning.mockRestore();
  }
});

it('compiles from source when the container lacks the requested profile', async () => {
  const { loadPackagedEngineShaderInputs } = await import('../shared-engine-inputs.js');
  expect(loadPackagedEngineShaderInputs(false, true)).not.toBeNull();
  expect(loadPackagedEngineShaderInputs(true, true)).toBeNull();
});
