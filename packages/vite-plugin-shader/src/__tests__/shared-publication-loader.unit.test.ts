import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  createMaterialProgramArtifactReceipt,
  expandShaderManifestPublication,
  LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
  LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
} from '@forgeax/engine-shader';
import { MATERIAL_WGSL_PROFILE } from '@forgeax/engine-shader-compiler';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publishShaderManifest } from '../manifest-publication.js';
import {
  loadSharedEngineShaderManifest,
  projectShaderManifestInput,
} from '../shared-engine-inputs.js';

let root: string;
let manifestPath: string;
const wgsl = '// source \u00e9\r\nfn main() {}\n// final bytes  ';
const reflection = { schemaVersion: 'shader-reflection/3', uvSetCount: 0, boundGlobals: [] };
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
const engineIdentifiers = [
  'forgeax::default-standard-pbr',
  'forgeax::pbr-skin',
  'forgeax::default-shadow-caster',
  'forgeax::default-unlit',
  ...resampling.map(({ identifier }) => identifier),
  'forgeax::water-info-raster-water',
  'forgeax::water-info-raster-ground',
  'forgeax::water-info-raster-dilation',
  'forgeax::water-mesh-raster',
  'forgeax::water-mesh-precise',
  'forgeax::water-mesh-precise-msaa',
];
const waterInfoIdentifiers = new Set([
  'forgeax::water-info-raster-water',
  'forgeax::water-info-raster-ground',
  'forgeax::water-info-raster-dilation',
  'forgeax::water-mesh-raster',
]);
const waterInfoReceipt = {
  ...createMaterialProgramArtifactReceipt({
    schema: [],
    directEntry: 'vs_main',
    vertexInputs: [],
  }),
  bindings: 'group-0' as const,
};
const entries = engineIdentifiers.map((identifier, index) => {
  const helper = resampling.find((entry) => entry.identifier === identifier);
  return {
    hash: (index + 1).toString(16).padStart(8, '0'),
    identifier,
    wgsl,
    glsl: '',
    bindings: '[]',
    compilerProfile: MATERIAL_WGSL_PROFILE,
    reflection,
    entryPoints: helper?.entryPoints ?? [],
    ...(helper === undefined ? {} : { programContract: helper.programContract }),
  };
});
const materialShaders = entries.map((entry) => ({
  identifier: entry.identifier,
  sourcePath: `${entry.identifier}.wgsl`,
  hash: entry.hash,
  compilerProfile: entry.compilerProfile,
  reflection: entry.reflection,
  entryPoints: entry.entryPoints,
  composedWgsl: wgsl,
  paramSchema: '[]',
  variants: [],
  ...(waterInfoIdentifiers.has(entry.identifier) ? { receipt: waterInfoReceipt } : {}),
}));

function writePayload(value: unknown): void {
  writeFileSync(join(root, 'shared/shaders.json'), JSON.stringify(value));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shared-publication-loader-'));
  mkdirSync(join(root, 'shared'));
  manifestPath = join(root, 'shared/manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      producer: 'repo-build-inputs',
      inputFingerprint: 'test-source',
      inventory: ['shared/shaders.json'],
      payload: { engineShaderManifest: 'shared/shaders.json' },
    }),
  );
  writePayload(publishShaderManifest(entries, materialShaders));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('serializes admitted shared blocks without expanding and splitting every material again', async () => {
  const publication = publishShaderManifest(entries, materialShaders);
  writePayload(publication);
  vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', manifestPath);
  const { buildEngineShaderManifest } = await import('../index.js');
  const split = String.prototype.split;
  let repeatedSplits = 0;
  const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (
    this: string,
    separator: unknown,
    limit?: number,
  ) {
    if (separator === '\n\n' && String(this) === wgsl) repeatedSplits++;
    return Reflect.apply(split, this, [separator, limit]) as string[];
  });
  try {
    const manifest = await buildEngineShaderManifest({ workspaceRoot: root });
    const wire = JSON.parse(JSON.stringify(manifest));
    expect(wire).toEqual({
      ...publication,
      entries: publication.entries.map((entry) => ({ ...entry, glsl: '' })),
    });
    expect(repeatedSplits).toBe(0);
    // Reusing admitted blocks must not turn an in-place replacement into a
    // stale cache hit or bypass the source digest check.
    publication.fragments[0] += 'corrupt';
    writePayload(publication);
    await expect(buildEngineShaderManifest({ workspaceRoot: root })).rejects.toThrow(
      'digest mismatch',
    );
  } finally {
    spy.mockRestore();
  }
});

it('rejects shared engine profiles whose variant artifacts lack their own reflection', async () => {
  const materialShadersWithIncompleteVariant = materialShaders.map((entry) =>
    entry.identifier === 'forgeax::default-standard-pbr'
      ? {
          ...entry,
          variants: [
            {
              definesKey: 'STORAGE_BUFFER_AVAILABLE=false',
              defines: { STORAGE_BUFFER_AVAILABLE: false },
              hash: 'abcdef01',
              compilerProfile: MATERIAL_WGSL_PROFILE,
              composedWgsl: wgsl,
            },
          ],
        }
      : entry,
  );
  writePayload(publishShaderManifest(entries, materialShadersWithIncompleteVariant));
  vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', manifestPath);
  const { buildEngineShaderManifest } = await import('../index.js');
  await expect(buildEngineShaderManifest({ workspaceRoot: root })).rejects.toThrow(
    'shared input is incomplete or stale',
  );
});

it('loads exact shared shader bytes in Node without a browser Crypto global', async () => {
  vi.stubGlobal('crypto', undefined);
  const join = Array.prototype.join;
  const composed: string[] = [];
  const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
    this: unknown[],
    separator?: string,
  ) {
    const result = Reflect.apply(join, this, [separator]) as string;
    if (separator === '' && result === wgsl) composed.push(result);
    return result;
  });
  const loaded = await loadSharedEngineShaderManifest(manifestPath, root);
  const expected = expandShaderManifestPublication(publishShaderManifest(entries, materialShaders))
    .manifest as { entries: unknown[]; materialShaders: unknown[] };
  expect(composed).toEqual([]);
  spy.mockRestore();
  expect({ entries: loaded.entries, materialShaders: loaded.materialShaders }).toEqual({
    entries: expected.entries,
    materialShaders: expected.materialShaders,
  });
  expect(loaded.publication).toEqual(publishShaderManifest(entries, materialShaders));
});

it('owns private parsed reflection facts while rejecting malformed unused reflections eagerly', async () => {
  const loaded = await loadSharedEngineShaderManifest(manifestPath, root);
  expect(loaded.entries[0]?.reflection).toBe(loaded.publication.reflections[0]);
  expect(Object.isFrozen(loaded.publication.reflections[0])).toBe(true);
  const malformed = publishShaderManifest(entries, materialShaders);
  malformed.reflections.push({ ...reflection, schemaVersion: 'invalid' });
  writePayload(malformed);
  await expect(loadSharedEngineShaderManifest(manifestPath, root)).rejects.toThrow(
    'Invalid shader manifest publication',
  );
});

it('shares live immutable admission while keeping consumer collections independent', async () => {
  const first = await loadSharedEngineShaderManifest(manifestPath, root);
  const next = await loadSharedEngineShaderManifest(manifestPath, root);
  expect(next.publication).toBe(first.publication);
  expect(next.entries).not.toBe(first.entries);
  expect(next.entries[0]).toBe(first.entries[0]);
  expect(Object.isFrozen(first.entries[0])).toBe(true);
  expect(Object.isFrozen(first.publication)).toBe(true);
  expect(Object.isFrozen(first.publication.reflections)).toBe(true);
  expect(Object.isFrozen(first.publication.reflections[0])).toBe(true);
  first.entries.splice(0);
  expect(next.entries.length).toBeGreaterThan(0);
  rmSync(join(root, 'shared/shaders.json'));
  await expect(loadSharedEngineShaderManifest(manifestPath, root)).rejects.toThrow(
    'inventory is missing',
  );
});

it('projects shared row defaults without reading or replacing its lazy source owner', async () => {
  let reads = 0;
  const loaded = await loadSharedEngineShaderManifest(manifestPath, root);
  const entry = loaded.entries[0];
  if (entry === undefined) throw new Error('Shared fixture entry is missing');
  const row = { ...entry };
  Object.defineProperty(row, 'wgsl', {
    enumerable: true,
    get() {
      reads += 1;
      return wgsl;
    },
  });
  Object.freeze(row);
  const projected = projectShaderManifestInput(row, { uvSetCount: 0, glsl: '' });
  expect(reads).toBe(0);
  expect(projected.uvSetCount).toBe(0);
  expect(projected.glsl).toBe('');
  expect(Object.getOwnPropertyDescriptor(projected, 'wgsl')?.get).toBe(
    Object.getOwnPropertyDescriptor(row, 'wgsl')?.get,
  );
  expect(projected.wgsl).toBe(wgsl);
  expect(reads).toBe(1);
});

it('rejects changed source bytes under an unchanged source digest', async () => {
  const previous = await loadSharedEngineShaderManifest(manifestPath, root);
  const publication = publishShaderManifest(entries, materialShaders);
  publication.fragments[0] += ' ';
  writePayload(publication);
  await expect(loadSharedEngineShaderManifest(manifestPath, root)).rejects.toThrow(
    'digest mismatch',
  );
  expect(Object.isFrozen(previous.publication)).toBe(true);
});

it('rejects unused source digests before accepting the shared publication', async () => {
  const publication = publishShaderManifest(entries, materialShaders);
  publication.sources['0'.repeat(64)] = [0];
  writePayload(publication);
  await expect(loadSharedEngineShaderManifest(manifestPath, root)).rejects.toThrow(
    'missing or unused',
  );
});

it('retains the producer inventory gate before loading shader rows', async () => {
  rmSync(join(root, 'shared/shaders.json'));
  await expect(loadSharedEngineShaderManifest(manifestPath, root)).rejects.toThrow(
    'inventory is missing',
  );
});

it.each([
  '.',
  'shared-build-inputs',
  'cache/nested/profile',
  '../external/profile',
])('resolves repository-relative inventory at %s from the consumer project context', async (outputDirectory) => {
  const fixture = mkdtempSync(join(tmpdir(), 'shared-root-authority-'));
  const repository = join(fixture, 'checkout');
  const output = join(repository, outputDirectory);
  const payloadPath = join(output, 'shaders/manifest.json');
  const transferPath = join(output, 'manifest.json');
  const payload = relative(repository, payloadPath).replaceAll('\\', '/');
  try {
    mkdirSync(repository, { recursive: true });
    writeFileSync(join(repository, 'pnpm-workspace.yaml'), 'packages: []\n');
    const nestedProject = join(repository, 'apps/hello/fixture');
    mkdirSync(nestedProject, { recursive: true });
    mkdirSync(dirname(payloadPath), { recursive: true });
    writeFileSync(payloadPath, JSON.stringify(publishShaderManifest(entries, materialShaders)));
    writeFileSync(
      transferPath,
      JSON.stringify({
        schemaVersion: 2,
        producer: 'repo-build-inputs',
        inputFingerprint: 'explicit-root-fixture',
        inventory: [payload],
        payload: { engineShaderManifest: payload },
      }),
    );
    const loaded = await loadSharedEngineShaderManifest(transferPath, repository);
    expect(loaded.publication).toEqual(publishShaderManifest(entries, materialShaders));
    vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', transferPath);
    const { buildEngineShaderManifest } = await import('../index.js');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(nestedProject);
    try {
      const built = await buildEngineShaderManifest();
      expect(JSON.parse(JSON.stringify(built))).toEqual({
        ...loaded.publication,
        entries: loaded.publication.entries.map((entry) => ({ ...entry, glsl: '' })),
      });
    } finally {
      cwd.mockRestore();
    }
    const wrongProject = join(fixture, 'other/checkout');
    mkdirSync(wrongProject, { recursive: true });
    await expect(loadSharedEngineShaderManifest(transferPath, wrongProject)).rejects.toThrow(
      'inventory is missing',
    );
    rmSync(payloadPath);
    await expect(loadSharedEngineShaderManifest(transferPath, repository)).rejects.toThrow(
      'inventory is missing',
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
