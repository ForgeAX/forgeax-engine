import {
  type CookedMaterialRecord,
  createMaterialArtifactDigest,
  createMaterialProgramSetDigest,
  type MaterialCookProgram,
  type MaterialCookProgramContext,
} from '@forgeax/engine-pack/material-cook';
import { MaterialArtifactRegistry, ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialProgramAbi } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { inspectMaterialRuntime } from '../material/inspection.js';
import { createMaterialLoader, type MaterialPublication } from '../material/loader.js';
import {
  findMaterialPassProgram,
  installMaterialReadyShaders,
  projectMaterialRecord,
  selectMaterialPassProgram,
} from '../material/runtime-shader.js';

const context: MaterialCookProgramContext = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
};

const submissionAbi = {
  directEntry: 'vs_main',
  sceneIndexEntry: 'vs_scene_index',
  materialRow: { addressUnitBytes: 16, byteLength: 16, fields: [] },
  resourceSlots: [],
  uvSets: [],
  vertexInputs: [],
  alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' },
  reflection: { layoutIdentity: 'layout', resourceSlots: [], vertexInputs: [] },
  receiptIdentity: 'custom-layout',
  generation: 1,
} satisfies MaterialProgramAbi;
function pair(pass: string, context: MaterialCookProgramContext) {
  return (['direct', 'scene-index'] as const).map((address) => ({
    pass,
    context,
    address,
    entry: address === 'direct' ? submissionAbi.directEntry : submissionAbi.sceneIndexEntry,
    abi: submissionAbi,
  }));
}
function fixture() {
  const passes = ['Forward', 'Overlay'].map((name) => ({ name, program: { module: name } }));
  const programs = passes.map(({ name }) => {
    const bytes = new TextEncoder().encode(`program ${name}`);
    return {
      specializationKey: name,
      artifact: {
        mediaType: 'text/wgsl',
        path: `${name}.wgsl`,
        digest: createMaterialArtifactDigest(bytes),
        bytes,
      },
      selections: pair(name, context),
    };
  });
  const artifactDigest = createMaterialProgramSetDigest(programs, passes);
  const record: CookedMaterialRecord = {
    schemaVersion: 'material-cook/5',
    guid: 'material',
    materialGuid: 'material',
    publicationGeneration: 1,
    specializationKey: 'publication',
    artifactDigest,
    sourceClosure: ['material.json'],
    parameterContract: { parameters: [], values: {} },
    resolved: { passes, parameters: [], values: {} },
    refs: { parent: [], textures: [], samplers: [], modules: [] },
    programs,
    receipt: {
      schemaVersion: 'material-cook/5',
      sourceClosure: ['material.json'],
      profile: 'webgpu/v1',
      compilerVersion: 'test',
      identity: {
        materialContractDigest: 'contract',
        sourceRevision: 'source',
        sourceClosureDigest: 'closure',
        layoutIdentity: 'layout',
        programIdentity: 'program',
        pipelineIdentity: 'pipeline',
        materialPublicationIdentity: 'publication',
        cookIdentity: 'cook',
        compilerFingerprint: 'compiler',
        wasm: { sourceContentKey: 'source', artifactSha256: 'artifact', glueSha256: 'glue' },
        artifactDigest,
        valueGeneration: 1,
        dependencyGeneration: 1,
        cookGeneration: 1,
      },
      derivedInterface: { layoutIdentity: 'layout' },
    },
  };
  const artifacts = Object.fromEntries(
    programs.map(({ artifact }) => [
      artifact.path,
      { bytes: new Uint8Array(artifact.bytes), digest: artifact.digest },
    ]),
  );
  const publication: MaterialPublication = { guid: 'material', record, artifacts };
  return { record, artifacts, publication };
}
const request = { guid: 'material', specializationKey: 'publication' };
const load = (publication: MaterialPublication) =>
  createMaterialLoader({ loadPublication: async () => publication }).load(request);

it('publishes Ready only after every program has verified immutable bytes', async () => {
  const { publication, artifacts } = fixture();
  const result = await load(publication);
  expect(result.status).toBe('Ready');
  if (result.status !== 'Ready') throw new Error('Expected Ready');
  expect(result.record.programs).toHaveLength(2);
  const before = result.record.programs[1]?.artifact.bytes.slice();
  artifacts['Overlay.wgsl']?.bytes.fill(0);
  expect(result.record.programs[1]?.artifact.bytes).toEqual(before);
});

it('rejects a missing or corrupted second program instead of publishing a partial generation', async () => {
  const { publication, artifacts } = fixture();
  delete artifacts['Overlay.wgsl'];
  expect(await load(publication)).toMatchObject({
    status: 'Error',
    error: { code: 'asset-artifact-missing', detail: { field: 'Overlay.wgsl' } },
  });
  artifacts['Overlay.wgsl'] = { bytes: new TextEncoder().encode('old generation'), digest: 'old' };
  expect(await load(publication)).toMatchObject({
    status: 'Error',
    error: { code: 'asset-artifact-integrity-mismatch', detail: { field: 'Overlay.wgsl' } },
  });
});

it('preserves the first integrity failure before a later artifact read throws', async () => {
  const { publication, artifacts } = fixture();
  const first = artifacts['Forward.wgsl'];
  if (first === undefined) throw new Error('Expected Forward fixture');
  artifacts['Forward.wgsl'] = { ...first, digest: 'sha256:wrong' };
  const laterFailure = new Error('later artifact read');
  Object.defineProperty(artifacts, 'Overlay.wgsl', {
    get: () => {
      throw laterFailure;
    },
  });

  await expect(load(publication)).resolves.toMatchObject({
    status: 'Error',
    error: { code: 'asset-artifact-integrity-mismatch', detail: { field: 'Forward.wgsl' } },
  });
});

it('installs programs under their own keys and preserves each Pass selection', async () => {
  const { publication } = fixture();
  const ready = await load(publication);
  if (ready.status !== 'Ready') throw new Error('Expected Ready');
  const shaders = new ShaderRegistry({
    device: {
      createShaderModule: () => {
        throw new Error('Program installation must not compile GPU modules');
      },
    } as never,
    manifestUrl: undefined,
  });
  const artifacts = new MaterialArtifactRegistry();
  const projection = installMaterialReadyShaders(shaders, ready, artifacts);
  expect(
    projection.passes.map((pass) => [
      ...new Set(pass.programs.map((program) => program.specializationKey)),
    ]),
  ).toEqual([['Forward'], ['Overlay']]);
  expect(shaders.findMaterialArtifact('Forward').ok).toBe(true);
  expect(shaders.findMaterialArtifact('Overlay').ok).toBe(true);
  expect(shaders.findMaterialArtifact('publication').ok).toBe(false);
});

it('leaves both registries unchanged when a later program conflicts', async () => {
  const { publication } = fixture();
  const ready = await load(publication);
  if (ready.status !== 'Ready') throw new Error('Expected Ready');
  const shaders = new ShaderRegistry({
    device: {
      createShaderModule: () => {
        throw new Error('Program installation must not compile GPU modules');
      },
    } as never,
    manifestUrl: undefined,
  });
  const artifacts = new MaterialArtifactRegistry();
  artifacts
    .register({
      key: 'Overlay',
      bytes: new TextEncoder().encode('conflicting prior program'),
      metadata: { paramSchema: [] },
    })
    .unwrap();
  expect(() => installMaterialReadyShaders(shaders, ready, artifacts)).toThrow(
    'material-artifact-conflict',
  );
  expect(artifacts.get('Forward')).toBeUndefined();
  expect(shaders.findMaterialArtifact('Forward').ok).toBe(false);
  expect(shaders.findMaterialArtifact('Overlay').ok).toBe(false);
});

it('selects the exact Pass and context and refuses unsupported or ambiguous selections', () => {
  const { record } = fixture();
  const projection = projectMaterialRecord(record);
  expect(selectMaterialPassProgram(projection, 'Overlay', context).specializationKey).toBe(
    'Overlay',
  );
  expect(() =>
    selectMaterialPassProgram(projection, 'Overlay', { ...context, geometry: 'skinned' }),
  ).toThrow('no unique published program');
  expect(() => selectMaterialPassProgram(projection, 'Missing', context)).toThrow(
    'no unique published program',
  );
  expect(() =>
    selectMaterialPassProgram(
      { ...projection, passes: [...projection.passes, ...projection.passes] },
      'Forward',
      context,
    ),
  ).toThrow('no unique published program');
});

it('returns optional absence without building a diagnostic context and retains strict failures', () => {
  const { record } = fixture();
  const projection = projectMaterialRecord(record);
  let diagnosticReads = 0;
  const selectedContext = {
    ...context,
    get toolchain() {
      diagnosticReads++;
      return context.toolchain;
    },
  };
  expect(findMaterialPassProgram(projection, 'Missing', selectedContext)).toBeUndefined();
  expect(diagnosticReads).toBe(0);
  expect(() => selectMaterialPassProgram(projection, 'Missing', selectedContext)).toThrow(
    expect.objectContaining({
      code: 'material-specialization-not-cooked',
      detail: expect.objectContaining({ matches: 0, context: selectedContext }),
    }),
  );
  expect(diagnosticReads).toBeGreaterThan(0);
  expect(() =>
    findMaterialPassProgram(
      { ...projection, passes: [...projection.passes, ...projection.passes] },
      'Forward',
      context,
    ),
  ).toThrow(expect.objectContaining({ detail: expect.objectContaining({ matches: 2 }) }));
});

it('observes borrowed program and context getters for each optional lookup', () => {
  const { record } = fixture();
  const projection = projectMaterialRecord(record);
  const firstPass = projection.passes[0];
  const original = firstPass?.programs[0];
  if (firstPass === undefined || original === undefined) throw new Error('missing fixture program');
  let current = original;
  const programs = [
    {
      ...original,
      get context() {
        return current.context;
      },
      get specializationKey() {
        return current.specializationKey;
      },
    },
  ];
  const borrowed = { ...projection, passes: [{ ...firstPass, programs }] };
  expect(findMaterialPassProgram(borrowed, 'Forward', context)?.specializationKey).toBe('Forward');
  current = { ...original, context: { ...context, geometry: 'skinned' } };
  expect(findMaterialPassProgram(borrowed, 'Forward', context)).toBeUndefined();
  current = { ...original, specializationKey: 'replacement-generation' };
  expect(findMaterialPassProgram(borrowed, 'Forward', context)?.specializationKey).toBe(
    'replacement-generation',
  );
  const duplicate = programs[0];
  if (duplicate === undefined) throw new Error('missing fixture program');
  programs.push(duplicate);
  expect(() => findMaterialPassProgram(borrowed, 'Forward', context)).toThrow(
    expect.objectContaining({ detail: expect.objectContaining({ matches: 2 }) }),
  );
});

it('selects a multi-program publication without sorting context fields on every lookup', () => {
  const { record } = fixture();
  const source = record.programs[0];
  if (source === undefined) throw new Error('missing fixture program');
  const contexts: MaterialCookProgramContext[] = Array.from({ length: 32 }, (_, index) => ({
    ...context,
    backend: index & 1 ? 'wgpu-native' : 'webgpu',
    capability: index & 2 ? 'storage-buffer-atmosphere' : 'storage-buffer',
    pipeline: index & 4 ? 'deferred' : 'forward',
    geometry: index & 8 ? 'skinned' : 'mesh',
    instrumentation: index & 16 ? 'validation' : 'none',
  }));
  const projection = projectMaterialRecord({
    ...record,
    programs: contexts.map((selected, index) => ({
      ...source,
      specializationKey: `program-${index}`,
      selections: pair('Forward', selected),
    })),
  });
  const sorting = vi.spyOn(String.prototype, 'localeCompare');
  let sortCalls: number;
  try {
    for (let round = 0; round < 2; round++)
      for (const [index, selected] of contexts.entries())
        expect(
          selectMaterialPassProgram(projection, 'Forward', { ...selected }).specializationKey,
        ).toBe(`program-${index}`);
    sortCalls = sorting.mock.calls.length;
  } finally {
    sorting.mockRestore();
  }
  expect(sortCalls).toBe(0);
});

it('compares every current context axis independently of property order and absent optional fields', () => {
  const { record } = fixture();
  const projection = projectMaterialRecord(record);
  const reordered = Object.fromEntries(
    Object.entries(context).reverse(),
  ) as MaterialCookProgramContext;
  expect(selectMaterialPassProgram(projection, 'Forward', reordered).specializationKey).toBe(
    'Forward',
  );
  expect(
    selectMaterialPassProgram(projection, 'Forward', {
      ...context,
      visibleSurface: undefined,
    } as unknown as MaterialCookProgramContext).specializationKey,
  ).toBe('Forward');
  for (const different of [
    { backend: 'wgpu-native' },
    { capability: 'storage-buffer-atmosphere' },
    { pipeline: 'deferred' },
    { geometry: 'skinned' },
    { pass: 'depth' },
    { profile: 'forgeax-material-ray-v1' },
    { toolchain: 'different-toolchain' },
    { instrumentation: 'validation' },
    { visibleSurface: true },
  ])
    expect(() =>
      selectMaterialPassProgram(projection, 'Forward', {
        ...context,
        ...different,
      } as MaterialCookProgramContext),
    ).toThrow('no unique published program');
});

it('reads changed caller-owned projection facts after successful and missing lookups', () => {
  const { record } = fixture();
  const projection = projectMaterialRecord(record);
  const passes = projection.passes.map((pass) => ({
    ...pass,
    programs: pass.programs.map((program) => ({ ...program, context: { ...program.context } })),
  }));
  const mutable = { ...projection, passes };
  const program = passes[0]?.programs[0];
  if (program === undefined) throw new Error('missing fixture program');
  expect(selectMaterialPassProgram(mutable, 'Forward', context)).toBe(program);
  const skinned = { ...context, geometry: 'skinned' } as const;
  expect(() => selectMaterialPassProgram(mutable, 'Forward', skinned)).toThrow(
    'no unique published program',
  );
  program.context = skinned;
  expect(selectMaterialPassProgram(mutable, 'Forward', skinned)).toBe(program);
  expect(() => selectMaterialPassProgram(mutable, 'Forward', context)).toThrow(
    'no unique published program',
  );
  mutable.publicationGeneration++;
  program.specializationKey = 'replacement-generation';
  expect(selectMaterialPassProgram(mutable, 'Forward', skinned).specializationKey).toBe(
    'replacement-generation',
  );
  passes[0]?.programs.push({ ...program });
  expect(() => selectMaterialPassProgram(mutable, 'Forward', skinned)).toThrow(
    'no unique published program',
  );
});

it('selects direct and scene-index entries from one projected publication', () => {
  const { record } = fixture();
  const forward = record.programs[0];
  if (forward === undefined) throw new Error('Forward fixture program is missing');
  const projection = projectMaterialRecord(record);
  expect(selectMaterialPassProgram(projection, 'Forward', context, 'direct')).toMatchObject({
    address: 'direct',
    entry: 'vs_main',
    abi: submissionAbi,
  });
  expect(selectMaterialPassProgram(projection, 'Forward', context, 'scene-index')).toMatchObject({
    address: 'scene-index',
    entry: 'vs_scene_index',
    abi: submissionAbi,
  });
  expect(forward.selections).toHaveLength(2);
});

it('prefers the published color ABI while accepting unused mesh color and rejecting unavailable inputs', () => {
  const { record } = fixture();
  const projection = projectMaterialRecord(record);
  const pass = projection.passes[0];
  if (pass === undefined || pass.programs[0] === undefined)
    throw new Error('missing fixture program');
  const plain = { ...pass.programs[0], address: 'direct' as const, abi: submissionAbi };
  const colored = {
    ...plain,
    specializationKey: 'colored',
    abi: {
      ...submissionAbi,
      vertexInputs: [{ semantic: 'color', location: 13, format: 'float32x4' }],
    },
  } as typeof plain;
  const withPrograms = (programs: typeof pass.programs) => ({
    ...projection,
    passes: [{ ...pass, programs }],
  });
  expect(
    selectMaterialPassProgram(withPrograms([plain, colored]), pass.name, context).specializationKey,
  ).toBe(plain.specializationKey);
  expect(
    selectMaterialPassProgram(withPrograms([plain, colored]), pass.name, context, 'direct', true)
      .specializationKey,
  ).toBe('colored');
  for (const programs of [
    [colored, plain],
    [plain, plain, colored],
    [colored, plain, plain],
  ])
    expect(
      selectMaterialPassProgram(withPrograms(programs), pass.name, context, 'direct', true)
        .specializationKey,
    ).toBe('colored');
  expect(
    selectMaterialPassProgram(withPrograms([plain]), pass.name, context, 'direct', true)
      .specializationKey,
  ).toBe(plain.specializationKey);
  expect(() => selectMaterialPassProgram(withPrograms([colored]), pass.name, context)).toThrow(
    'no unique published program',
  );
  expect(() =>
    selectMaterialPassProgram(withPrograms([colored, colored]), pass.name, context, 'direct', true),
  ).toThrow('no unique published program');
  expect(() =>
    selectMaterialPassProgram(
      withPrograms([colored, plain, colored]),
      pass.name,
      context,
      'direct',
      true,
    ),
  ).toThrow('no unique published program');
});

it('loads and selects both Surface derivatives atomically through the same complete material publication', async () => {
  const { record } = fixture();
  const bytes = new TextEncoder().encode('@compute @workgroup_size(64) fn cs_surface() {}');
  const rayContext = {
    backend: 'webgpu',
    capability: 'storage-buffer',
    pipeline: 'ray',
    geometry: 'mesh',
    pass: 'ray-hit',
    profile: 'forgeax-material-ray-v1',
    toolchain: 'naga-oil',
    instrumentation: 'none',
  } as const;
  const ray: MaterialCookProgram = {
    specializationKey: 'ray-surface',
    artifact: {
      mediaType: 'text/wgsl',
      path: 'ray.wgsl',
      bytes,
      digest: createMaterialArtifactDigest(bytes),
    },
    selections: [{ pass: 'Forward', context: rayContext, entry: 'cs_surface' }],
  };
  const cardBytes = new TextEncoder().encode(
    '@vertex fn vs_card() -> @builtin(position) vec4f { return vec4f(0); }',
  );
  const cardContext = { ...rayContext, pass: 'card-capture' } as const;
  const card: MaterialCookProgram = {
    specializationKey: 'card-surface',
    artifact: {
      mediaType: 'text/wgsl',
      path: 'card.wgsl',
      bytes: cardBytes,
      digest: createMaterialArtifactDigest(cardBytes),
    },
    selections: [{ pass: 'Forward', context: cardContext, entry: 'vs_card' }],
  };
  const programs: MaterialCookProgram[] = [...record.programs, ray, card];
  const artifactDigest = createMaterialProgramSetDigest(programs, record.resolved.passes);
  const complete = {
    ...record,
    programs,
    artifactDigest,
    receipt: { ...record.receipt, identity: { ...record.receipt.identity, artifactDigest } },
  };
  const artifacts = Object.fromEntries(
    programs.map(({ artifact }) => [
      artifact.path,
      {
        bytes: artifact.bytes.slice(),
        digest: artifact.digest,
      },
    ]),
  );
  const publication: MaterialPublication = { guid: 'material', record: complete, artifacts };
  const ready = await load(publication);
  expect(ready.status).toBe('Ready');
  if (ready.status !== 'Ready') throw new Error('shared publication did not load');
  const inspected = inspectMaterialRuntime(ready);
  const rayInfo = inspected.programs.find((program) => program.specializationKey === 'ray-surface');
  expect(rayInfo).toEqual({
    specializationKey: 'ray-surface',
    artifactDigest: ray.artifact.digest,
    byteLength: bytes.byteLength,
    selections: [{ pass: 'Forward', context: rayContext, entry: 'cs_surface' }],
  });
  expect(JSON.parse(JSON.stringify(inspected)).programs).toEqual(inspected.programs);
  const readyRay = ready.record.programs.find(
    (program) => program.specializationKey === 'ray-surface',
  );
  expect(readyRay).toBeDefined();
  expect(rayInfo?.selections).not.toBe(readyRay?.selections);
  expect(rayInfo?.selections[0]?.context).not.toBe(readyRay?.selections[0]?.context);
  const shaders = new ShaderRegistry({
    device: {
      createShaderModule: () => {
        throw new Error('Installation must not compile GPU modules');
      },
    } as never,
    manifestUrl: undefined,
  });
  const projection = installMaterialReadyShaders(shaders, ready, new MaterialArtifactRegistry());
  expect(selectMaterialPassProgram(projection, 'Forward', cardContext)).toMatchObject({
    specializationKey: 'card-surface',
    entry: 'vs_card',
  });
  expect(shaders.findMaterialArtifact('card-surface').unwrap().source).toBe(
    new TextDecoder().decode(cardBytes),
  );
  expect(() =>
    selectMaterialPassProgram(projection, 'Forward', cardContext, 'scene-index'),
  ).toThrow(/no unique published program/);
  const retainedCard = artifacts['card.wgsl'];
  delete artifacts['card.wgsl'];
  expect(await load(publication)).toMatchObject({
    status: 'Error',
    error: { code: 'asset-artifact-missing', detail: { field: 'card.wgsl' } },
  });
  artifacts['card.wgsl'] = {
    bytes: new TextEncoder().encode('corrupt Card'),
    digest: createMaterialArtifactDigest(new TextEncoder().encode('corrupt Card')),
  };
  expect(await load(publication)).toMatchObject({
    status: 'Error',
    error: { code: 'asset-artifact-integrity-mismatch', detail: { field: 'card.wgsl' } },
  });
  if (!retainedCard) throw new Error('missing Card artifact');
  artifacts['card.wgsl'] = retainedCard;
  expect(selectMaterialPassProgram(projection, 'Forward', rayContext)).toMatchObject({
    specializationKey: 'ray-surface',
    entry: 'cs_surface',
    artifactHash: ray.artifact.digest,
  });
  expect(shaders.findMaterialArtifact('ray-surface').unwrap().source).toBe(
    new TextDecoder().decode(bytes),
  );
  expect(selectMaterialPassProgram(projection, 'Forward', context, 'scene-index').entry).toBe(
    submissionAbi.sceneIndexEntry,
  );
  expect(() => selectMaterialPassProgram(projection, 'Forward', rayContext, 'scene-index')).toThrow(
    /no unique published program/,
  );
  expect(() =>
    selectMaterialPassProgram(projectMaterialRecord(record), 'Forward', rayContext),
  ).toThrow(/no unique published program/);

  delete artifacts['ray.wgsl'];
  expect(await load(publication)).toMatchObject({
    status: 'Error',
    error: {
      code: 'asset-artifact-missing',
      detail: { field: 'ray.wgsl' },
    },
  });
  const failed = await load(publication);
  if (failed.status !== 'Error') throw new Error('missing artifact must fail');
  const retained = inspectMaterialRuntime({ status: 'LastKnownGood', ready, failure: failed });
  expect(retained).toMatchObject({
    readiness: 'last-known-good',
    preparationFailure: { code: 'asset-artifact-missing', detail: { field: 'ray.wgsl' } },
    lastKnownGood: {
      publicationGeneration: ready.record.publicationGeneration,
      programs: inspected.programs,
    },
  });
  artifacts['ray.wgsl'] = {
    bytes: new TextEncoder().encode('stale ray source'),
    digest: createMaterialArtifactDigest(new TextEncoder().encode('stale ray source')),
  };
  expect(await load(publication)).toMatchObject({
    status: 'Error',
    error: {
      code: 'asset-artifact-integrity-mismatch',
      detail: { field: 'ray.wgsl' },
    },
  });
});
