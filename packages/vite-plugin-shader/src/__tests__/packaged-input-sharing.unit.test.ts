import { gzipSync } from 'node:zlib';
import {
  createMaterialProgramArtifactReceipt,
  expandShaderManifestPublication,
  LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
  LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
} from '@forgeax/engine-shader';
import { compileShader, MATERIAL_WGSL_PROFILE } from '@forgeax/engine-shader-compiler';
import { assert, beforeEach, expect, it, vi } from 'vitest';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries.js';
import { encodePackagedProfiles } from '../engine-inputs/packaged-profiles.js';
import { publishShaderManifest } from '../manifest-publication.js';
import { hasCompleteEngineShaderProfile } from '../shared-engine-inputs.js';

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
  options: {
    readonly includeResampling?: boolean;
    readonly includeWaterInfo?: boolean;
    readonly waterInfoReceipt?: boolean;
    readonly incompleteVariant?: boolean;
  } = {},
) {
  const source = 'fn main() {}';
  const waterInfoReceipt = {
    ...createMaterialProgramArtifactReceipt({
      schema: [],
      directEntry: 'vs_main',
      vertexInputs: [],
    }),
    bindings: 'group-0' as const,
  };
  const materials = [
    { identifier: 'forgeax::default-standard-pbr', entryPoints: [] },
    { identifier: 'forgeax::default-unlit', entryPoints: [] },
    ...(options.includeWaterInfo === false
      ? []
      : [
          'forgeax::water-info-raster-water',
          'forgeax::water-info-raster-ground',
          'forgeax::water-info-raster-dilation',
          'forgeax::water-mesh-raster',
        ].map((identifier) => ({
          identifier,
          entryPoints: [],
          ...(options.waterInfoReceipt === false ? {} : { receipt: waterInfoReceipt }),
        }))),
    ...['forgeax::water-mesh-precise', 'forgeax::water-mesh-precise-msaa'].map((identifier) => ({
      identifier,
      entryPoints: [
        { name: 'vs_main', stage: 'vertex' as const, bindings: [] },
        { name: 'fs_shadow', stage: 'fragment' as const, bindings: [] },
      ],
    })),
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
      ...('receipt' in material ? { receipt: material.receipt } : {}),
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

it('rejects packaged engine profiles missing required rows, WaterInfo receipts, or a variant reflection', async () => {
  const { loadPackagedEngineShaderInputs } = await import('../shared-engine-inputs.js');
  for (const manifest of [
    createManifest({ includeResampling: false }),
    createManifest({ includeWaterInfo: false }),
    createManifest({ waterInfoReceipt: false }),
    createManifest({ incompleteVariant: true }),
  ]) {
    files.manifest = JSON.stringify(manifest);
    files.container = undefined;
    expect(loadPackagedEngineShaderInputs(false, true)).toBeNull();
  }
});

it('admits actual resource-bound precise WaterMesh programs and rejects incomplete artifacts', async () => {
  const engine = await loadEngineShaderEntries();
  const precise = [];
  for (const entry of [engine.waterMeshPrecise, engine.waterMeshPreciseMsaa]) {
    const identifier = entry.reservedIdentifier;
    assert(identifier !== undefined);
    const compiled = (
      await compileShader(entry.source, {
        id: entry.id,
        defines: { WATER_PRECISE_MSAA: false, ...entry.defines },
      })
    ).unwrap();
    expect(compiled.bindings[0]?.entries.map((binding) => binding.binding)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(compiled.bindings[0]?.entries[6]?.texture?.multisampled).toBe(
      entry.defines?.WATER_PRECISE_MSAA === true,
    );
    precise.push({ entry, identifier, compiled });
  }
  type Profile = Parameters<typeof hasCompleteEngineShaderProfile>[0];
  const base = expandShaderManifestPublication(createManifest()).manifest as Profile;
  const actual = expandShaderManifestPublication(
    publishShaderManifest(
      precise.map(({ identifier, compiled }) => ({
        ...compiled.manifestEntry,
        identifier,
        compilerProfile: MATERIAL_WGSL_PROFILE,
      })),
      precise.map(({ entry, identifier, compiled }) => ({
        identifier,
        sourcePath: entry.id,
        hash: compiled.manifestEntry.hash,
        compilerProfile: MATERIAL_WGSL_PROFILE,
        reflection: compiled.reflection,
        entryPoints: compiled.manifestEntry.entryPoints,
        composedWgsl: compiled.wgsl,
        paramSchema: '[]',
        variants: [],
      })),
    ),
  ).manifest as Profile;
  const identifiers = new Set(precise.map(({ identifier }) => identifier));
  const profile = {
    entries: [
      ...base.entries.filter(
        (entry) => entry.identifier === undefined || !identifiers.has(entry.identifier),
      ),
      ...actual.entries,
    ],
    materialShaders: [
      ...base.materialShaders.filter((entry) => !identifiers.has(entry.identifier)),
      ...actual.materialShaders,
    ],
  };
  expect(hasCompleteEngineShaderProfile(profile)).toBe(true);
  for (const identifier of identifiers) {
    expect(
      hasCompleteEngineShaderProfile({
        ...profile,
        entries: profile.entries.filter((entry) => entry.identifier !== identifier),
      }),
    ).toBe(false);
    expect(
      hasCompleteEngineShaderProfile({
        ...profile,
        materialShaders: profile.materialShaders.filter((entry) => entry.identifier !== identifier),
      }),
    ).toBe(false);
    for (const rows of ['entries', 'materialShaders'] as const) {
      const corruptions: readonly (readonly [string, unknown])[] = [
        ['hash', 'invalid'],
        ['sourceDigest', 'invalid'],
        ['reflection', {}],
        ...(rows === 'materialShaders' ? [['compilerProfile', {}] as const] : []),
      ];
      for (const [field, value] of corruptions) {
        const invalid = structuredClone(profile);
        const row = invalid[rows].find((entry) => entry.identifier === identifier);
        assert(row !== undefined);
        Reflect.set(row, field, value);
        expect(hasCompleteEngineShaderProfile(invalid), `${rows}:${identifier}:${field}`).toBe(
          false,
        );
      }
    }
    const invalidVariant = structuredClone(profile);
    const material = invalidVariant.materialShaders.find(
      (entry) => entry.identifier === identifier,
    );
    assert(material !== undefined);
    Reflect.set(material, 'variants', [
      {
        ...material,
        definesKey: 'WATER_PRECISE_MSAA=true',
        defines: { WATER_PRECISE_MSAA: true },
        reflection: {},
      },
    ]);
    expect(hasCompleteEngineShaderProfile(invalidVariant)).toBe(false);
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
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(loadPackagedEngineShaderInputs(true, true)).toBeNull();
    expect(loadPackagedEngineShaderInputs(true, true)).toBeNull();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/requested profile is absent.*--build --profile point-ssao/),
    );
  } finally {
    warning.mockRestore();
  }
});

it('explains source fallback for an incomplete or stale compiler profile', async () => {
  const { loadPackagedEngineShaderInputs } = await import('../shared-engine-inputs.js');
  const manifest = JSON.parse(files.manifest);
  manifest.materialShaders[0].compilerProfile = { id: 'old compiler' };
  files.manifest = JSON.stringify(manifest);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(loadPackagedEngineShaderInputs(false, true)).toBeNull();
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(/incomplete or has stale compiler facts.*--build --profile base-ssao/),
    );
  } finally {
    warning.mockRestore();
  }
});
