import { gzipSync } from 'node:zlib';
import {
  LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
  LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
} from '@forgeax/engine-shader';
import { MATERIAL_WGSL_PROFILE } from '@forgeax/engine-shader-compiler';
import { beforeEach, expect, it, vi } from 'vitest';
import { encodePackagedProfiles } from '../engine-inputs/packaged-profiles.js';
import { publishShaderManifest } from '../manifest-publication.js';

const files = vi.hoisted(() => ({
  manifest: '',
  imports: '',
  sourceDigest: 'current',
  container: undefined as Buffer | undefined,
}));

const reflection = {
  schemaVersion: 'shader-reflection/3',
  uvSetCount: 0,
  boundGlobals: [],
} as const;
const resampling = [
  {
    identifier: LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
    entryPoints: [
      { name: 'light_texture_resample', stage: 'compute', bindings: [] },
      { name: 'light_texture_reduce', stage: 'compute', bindings: [] },
    ],
    programContract: { schemaVersion: 'shader-program-contract/1', colorTargets: [] },
  },
  {
    identifier: LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
    entryPoints: [
      { name: 'light_texture_fullscreen', stage: 'vertex', bindings: [] },
      { name: 'light_texture_resample_fragment', stage: 'fragment', bindings: [] },
    ],
    programContract: {
      schemaVersion: 'shader-program-contract/1',
      colorTargets: [
        { location: 0, format: 'rgba32float', numericType: 'float' },
        { location: 1, format: 'rgba8unorm', numericType: 'float' },
      ],
    },
  },
] as const;

function createManifest(
  options: { readonly includeResampling?: boolean; readonly incompleteVariant?: boolean } = {},
) {
  const source = 'fn main() {}';
  const materials = [
    { identifier: 'forgeax::default-standard-pbr', entryPoints: [] },
    { identifier: 'forgeax::default-unlit', entryPoints: [] },
    ...(options.includeResampling === false ? [] : resampling),
  ];
  const entries = materials.map((material, index) => ({
    hash: (index + 1).toString(16).padStart(8, '0'),
    identifier: material.identifier,
    wgsl: source,
    glsl: '',
    bindings: '[]',
    compilerProfile: MATERIAL_WGSL_PROFILE,
    reflection,
    entryPoints: material.entryPoints,
    ...('programContract' in material ? { programContract: material.programContract } : {}),
  }));
  return publishShaderManifest(
    entries,
    materials.map((material, index) => ({
      identifier: material.identifier,
      sourcePath: `packages/shader/src/${index}.wgsl`,
      hash: (index + 1).toString(16).padStart(8, '0'),
      compilerProfile: MATERIAL_WGSL_PROFILE,
      reflection,
      entryPoints: material.entryPoints,
      composedWgsl: source,
      paramSchema: '[]',
      variants:
        options.incompleteVariant === true && index === 0
          ? [
              {
                definesKey: 'STORAGE_BUFFER_AVAILABLE=false',
                defines: { STORAGE_BUFFER_AVAILABLE: false },
                hash: '00000009',
                compilerProfile: MATERIAL_WGSL_PROFILE,
                composedWgsl: source,
              },
            ]
          : [],
    })),
  );
}

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
  files.manifest = JSON.stringify(createManifest());
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
  manifest.entries[0].hash = 'f00dbabe';
  files.manifest = JSON.stringify(manifest);
  const changed = loadPackagedEngineShaderInputs(false, true);
  expect(changed?.entries[0]?.hash).toBe('f00dbabe');
  expect(changed?.materialShaders).not.toBe(first?.materialShaders);
  files.imports = JSON.stringify({
    'forgeax_material::slot::surface': 'updated surface source',
  });
  expect(loadPackagedEngineShaderInputs(false, true)?.imports).toEqual(JSON.parse(files.imports));
  expect(first?.entries[0]?.hash).toBe('00000001');
});

it('rejects packaged engine profiles missing resampling rows or a variant reflection', async () => {
  const { loadPackagedEngineShaderInputs } = await import('../shared-engine-inputs.js');
  for (const manifest of [
    createManifest({ includeResampling: false }),
    createManifest({ incompleteVariant: true }),
  ]) {
    files.manifest = JSON.stringify(manifest);
    files.container = undefined;
    expect(loadPackagedEngineShaderInputs(false, true)).toBeNull();
  }
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
