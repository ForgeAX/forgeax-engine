import { readFileSync } from 'node:fs';
import { deriveStandardLayerPlan, type MaterialProgramAbi } from '@forgeax/engine-types';
import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';
import {
  type CookedMaterialRecord,
  createMaterialArtifactDigest,
  createMaterialProgramSetDigest,
  type MaterialCookProgram,
  projectCookedMaterialRecord,
  serializeCookedMaterialRecord,
  validateCookedMaterialRecord,
  withMaterialPublicationGeneration,
} from '../evidence/material-cook.js';
import { forwardRasterContext } from './support/material-raster-context.js';

const submissionAbi = {
  directEntry: 'vs_main',
  sceneIndexEntry: 'vs_scene_index',
  materialRow: { addressUnitBytes: 16, byteLength: 16, fields: ['baseColor'] },
  resourceSlots: [],
  uvSets: [],
  vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
  alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' },
  reflection: {
    layoutIdentity: 'sha256:layout',
    resourceSlots: [],
    vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
  },
  receiptIdentity: 'custom/layout',
  generation: 1,
} satisfies MaterialProgramAbi;

const rasterContext = { ...forwardRasterContext } as const;
const schema = JSON.parse(
  readFileSync(new URL('../schema/material-cook.schema.json', import.meta.url), 'utf8'),
);
const validateJson = new Ajv({ strict: false }).compile(schema);

const record: CookedMaterialRecord = {
  schemaVersion: 'material-cook/5',
  guid: 'mat-root',
  authored: {
    kind: 'material',
    passes: [{ name: 'forward', program: { module: 'core/pbr' } }],
    parameters: [{ name: 'roughness', type: 'f32' }],
    values: { roughness: 0.5 },
  },
  resolved: {
    passes: [{ name: 'forward', program: { module: 'core/pbr' } }],
    parameters: [{ name: 'roughness', type: 'f32' }],
    values: { roughness: 0.5 },
  },
  refs: { parent: [], textures: [], samplers: [], modules: ['core/pbr'] },
  programs: [
    {
      specializationKey: 'sha256:program',
      selections: (['direct', 'scene-index'] as const).map((address) => ({
        pass: 'forward',
        context: rasterContext,
        address,
        abi: submissionAbi,
        entry: address === 'direct' ? submissionAbi.directEntry : submissionAbi.sceneIndexEntry,
      })),
      artifact: {
        mediaType: 'text/wgsl',
        path: 'materials/mat-root/forward.wgsl',
        digest: 'sha256:artifact',
        bytes: new TextEncoder().encode('shader'),
      },
    },
  ],
  receipt: {
    schemaVersion: 'material-cook/5',
    sourceClosure: ['materials/mat-root.material.json'],
    profile: 'webgpu/v1',
    compilerVersion: 'compiler/1',
    identity: {
      materialContractDigest: 'sha256:material-contract',
      sourceRevision: 'sha256:source-revision',
      sourceClosureDigest: 'sha256:source-closure',
      layoutIdentity: 'sha256:layout',
      programIdentity: 'sha256:program',
      pipelineIdentity: 'sha256:pipeline',
      materialPublicationIdentity: 'sha256:publication',
      cookIdentity: 'sha256:input',
      compilerFingerprint: 'sha256:compiler',
      wasm: {
        sourceContentKey: 'sha256:wasm-source',
        artifactSha256: 'sha256:wasm-artifact',
        glueSha256: 'sha256:wasm-glue',
      },
      artifactDigest: 'sha256:artifact',
      valueGeneration: 1,
      dependencyGeneration: 1,
      cookGeneration: 1,
    },
    derivedInterface: { layoutIdentity: 'sha256:layout' },
  },
};

function seal(value: CookedMaterialRecord): CookedMaterialRecord {
  return {
    ...value,
    receipt: {
      ...value.receipt,
      identity: {
        ...value.receipt.identity,
        artifactDigest: createMaterialProgramSetDigest(value.programs, value.resolved.passes),
      },
    },
  };
}

describe('cooked material schema', () => {
  it('admits the same publication when the consumer has different locale collation', () => {
    const primary = record.programs[0] as MaterialCookProgram;
    const selection = primary.selections[0];
    const sceneSelection = primary.selections[1];
    const pass = record.resolved.passes[0];
    if (selection === undefined || sceneSelection === undefined || pass === undefined)
      throw new Error('missing fixture pass');
    const source = seal({
      ...record,
      resolved: {
        ...record.resolved,
        passes: [
          {
            ...pass,
            renderState: {
              tags: {
                SurfaceModule: 'game::rusted_iron',
                SurfaceKind: 'standard',
                AlphaClip: 'disabled',
              },
            },
          },
        ],
      },
      programs: [
        {
          ...primary,
          specializationKey: 'sha256:Z',
          selections: [
            selection,
            sceneSelection,
            {
              ...selection,
              context: { ...selection.context, backend: 'webgl2', capability: 'uniform-fallback' },
            },
            {
              ...sceneSelection,
              context: {
                ...sceneSelection.context,
                backend: 'webgl2',
                capability: 'uniform-fallback',
              },
            },
          ],
        },
        {
          ...primary,
          specializationKey: 'sha256:a',
          selections: [selection, sceneSelection].map((entry) => ({
            ...entry,
            context: { ...entry.context, backend: 'wgpu-native' },
          })),
        },
      ],
    });
    const published = serializeCookedMaterialRecord(source);
    // Native mini-game JS engines need not provide the producer's ICU collation.
    const collation = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(function (other) {
        return String(this) < other ? -1 : String(this) > other ? 1 : 0;
      });
    try {
      expect(validateCookedMaterialRecord(JSON.parse(published))).toMatchObject({ ok: true });
      expect(serializeCookedMaterialRecord(source)).toBe(published);
      expect(
        createMaterialProgramSetDigest([...source.programs].reverse(), source.resolved.passes),
      ).toBe(source.receipt.identity.artifactDigest);
    } finally {
      collation.mockRestore();
    }
  });

  it('rebinds a verified publication generation without changing source evidence', () => {
    const source = seal(record);
    const rebound = withMaterialPublicationGeneration(source, 7);
    expect(rebound.ok).toBe(true);
    if (!rebound.ok) return;
    expect(rebound.value.publicationGeneration).toBe(7);
    expect(rebound.value.receipt.identity.cookGeneration).toBe(7);
    expect(source.receipt.identity.cookGeneration).toBe(1);
    expect(validateCookedMaterialRecord(rebound.value).ok).toBe(true);
  });

  it('round trips Surface derivatives beside raster address pairs and rejects inconsistent selections', () => {
    const raster = record.programs[0] as MaterialCookProgram;
    const [ray, card] = (['ray-hit', 'card-capture'] as const).map(
      (pass): MaterialCookProgram => ({
        ...raster,
        specializationKey: pass,
        selections: [
          {
            pass: 'forward',
            entry: pass === 'ray-hit' ? 'cs_surface' : 'vs_card',
            context: {
              ...rasterContext,
              pipeline: 'ray',
              profile: 'forgeax-material-ray-v1',
              pass,
            },
          },
        ],
      }),
    ) as [MaterialCookProgram, MaterialCookProgram];
    const modern = seal({ ...record, programs: [raster, ray, card] });
    const value = JSON.parse(serializeCookedMaterialRecord(modern));
    expect(validateCookedMaterialRecord(value)).toMatchObject({ ok: true });
    expect(validateJson(value), JSON.stringify(validateJson.errors)).toBe(true);

    for (const [index, changes] of [
      [
        1,
        [
          { address: 'direct' },
          { abi: submissionAbi },
          { entry: 'vs_main' },
          { visibleSurface: true },
          { backend: 'webgl2' },
          { geometry: 'skinned' },
        ],
      ],
      [
        2,
        [
          { address: 'direct' },
          { abi: submissionAbi },
          { entry: 'cs_surface' },
          { entry: 'fs_card' },
          { pass: 'raster-probe' },
          { visibleSurface: true },
        ],
      ],
    ] as const) {
      for (const change of changes) {
        const invalid = structuredClone(value);
        const selection = invalid.programs[index].selections[0];
        const contextChange =
          'visibleSurface' in change ||
          'backend' in change ||
          'geometry' in change ||
          'pass' in change;
        Object.assign(contextChange ? selection.context : selection, change);
        expect(validateCookedMaterialRecord(invalid).ok).toBe(false);
        if (index === 2) expect(validateJson(invalid), JSON.stringify(change)).toBe(false);
      }
      const duplicate = structuredClone(value);
      duplicate.programs.push({ ...duplicate.programs[index], specializationKey: 'duplicate' });
      expect(validateCookedMaterialRecord(duplicate)).toMatchObject({
        ok: false,
        error: { detail: { actual: 'ambiguous Pass/context selection' } },
      });
    }
    expect(validateCookedMaterialRecord(seal({ ...record, programs: [ray] }))).toMatchObject({
      ok: false,
      error: { detail: { actual: 'unpublished Pass' } },
    });
  });

  it('publishes and validates the root Surface model and dynamic schema', () => {
    const surface = {
      model: 'single-layer-medium' as const,
      module: 'game::water_surface_a',
      dynamicInput: {
        name: 'waterEvents',
        fields: [
          { name: 'position', type: 'vec3<f32>' as const },
          { name: 'time', type: 'f32' as const },
        ],
        maxRecords: 4,
        maxDomains: 2,
        maxPageBytes: 64,
        maxBindings: 1,
        maxEventsPerSample: 4,
      },
    };
    const result = validateCookedMaterialRecord({
      ...seal(record),
      resolved: { ...record.resolved, surface },
    });
    expect(result).toMatchObject({ ok: true, value: { resolved: { surface } } });
    if (!result.ok) return;
    expect(projectCookedMaterialRecord(result.value).resolved.surface).toEqual(surface);
  });

  it('requires the current receipt identity, provenance, and derived interface in the JSON schema', () => {
    expect(schema.properties.schemaVersion.const).toBe('material-cook/5');
    expect(schema.properties.receipt).toMatchObject({
      required: expect.arrayContaining(['identity', 'derivedInterface']),
      properties: {
        derivedInterface: expect.any(Object),
        identity: {
          type: 'object',
          required: expect.arrayContaining([
            'materialContractDigest',
            'sourceRevision',
            'sourceClosureDigest',
            'layoutIdentity',
            'programIdentity',
            'pipelineIdentity',
            'materialPublicationIdentity',
            'cookIdentity',
            'compilerFingerprint',
            'wasm',
            'artifactDigest',
            'valueGeneration',
            'dependencyGeneration',
            'cookGeneration',
          ]),
        },
      },
    });
  });

  it('serializes a stable cooked DTO and derives an artifact digest', () => {
    const first = serializeCookedMaterialRecord(seal(record));
    const second = serializeCookedMaterialRecord(seal({ ...record }));

    expect(first).toBe(second);
    expect(createMaterialArtifactDigest(new TextEncoder().encode('shader'))).toBe(
      'sha256:e137e75a5e0e7a623ca39de480667a55b43e0eedec58767634ebaef07c33383a',
    );
    expect(validateCookedMaterialRecord(JSON.parse(first))).toEqual({
      ok: true,
      value: seal(record),
    });
  });

  it('projects cooked data without exposing an authored GUID entry', () => {
    const projection = projectCookedMaterialRecord(record);

    expect(projection.resolved.values).toEqual({ roughness: 0.5 });
    expect(projection.programs[0]?.artifact.digest).toBe('sha256:artifact');
    expect(projection).not.toHaveProperty('guid');
    expect(projection).not.toHaveProperty('authored');
  });

  it('admits different programs with equal entry names and shared programs with multiple selections', () => {
    const primary = record.programs[0] as MaterialCookProgram;
    const passes = [
      ...record.resolved.passes,
      {
        name: 'second',
        program: { module: 'other', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
      },
    ];
    const selections = primary.selections.map((entry) => ({
      ...entry,
      pass: 'second',
    })) as MaterialCookProgram['selections'];
    const distinct = seal({
      ...record,
      resolved: { ...record.resolved, passes },
      programs: [
        primary,
        {
          ...primary,
          specializationKey: 'second',
          artifact: {
            ...primary.artifact,
            path: 'second.wgsl',
            digest: 'sha256:second',
            bytes: new TextEncoder().encode('other'),
          },
          selections,
        },
      ],
    });
    expect(validateCookedMaterialRecord(distinct)).toMatchObject({ ok: true });
    const shared = seal({
      ...distinct,
      programs: [{ ...primary, selections: [...primary.selections, ...selections] }],
    });
    expect(validateCookedMaterialRecord(shared)).toMatchObject({ ok: true });
  });

  it('requires both entries of a paired raster ABI', () => {
    const { programs } = seal(record);
    const primary = programs[0] as MaterialCookProgram;
    expect(validateCookedMaterialRecord(seal(record))).toMatchObject({ ok: true });
    expect(
      validateCookedMaterialRecord({
        ...record,
        programs: [{ ...primary, selections: [primary.selections[0]] }],
      }),
    ).toMatchObject({
      ok: false,
      error: { detail: { actual: expect.stringContaining('incomplete submission address pair') } },
    });
  });

  it('accepts a direct-only ABI and rejects a claimed scene address without its entry', () => {
    const primary = record.programs[0];
    const context = primary?.selections[0]?.context;
    if (primary === undefined || context === undefined) throw new Error('missing fixture program');
    const { sceneIndexEntry: _sceneIndexEntry, ...directAbi } = submissionAbi;
    const direct = {
      pass: 'forward',
      context,
      address: 'direct' as const,
      entry: directAbi.directEntry,
      abi: directAbi,
    };
    const directOnly = seal({ ...record, programs: [{ ...primary, selections: [direct] }] });
    const json = JSON.parse(serializeCookedMaterialRecord(directOnly));
    expect(validateJson(json), JSON.stringify(validateJson.errors)).toBe(true);
    expect(validateCookedMaterialRecord(json).ok).toBe(true);
    const invalid = seal({
      ...record,
      programs: [
        {
          ...primary,
          selections: [direct, { ...direct, address: 'scene-index', entry: 'vs_scene_index' }],
        },
      ],
    });
    expect(validateCookedMaterialRecord(invalid)).toMatchObject({
      ok: false,
      error: { detail: { field: 'programs[0].selections[1].entry' } },
    });
  });

  it('rejects a partially modern publication instead of assigning missing address facts to direct', () => {
    const primary = record.programs[0] as MaterialCookProgram;
    const context = primary.selections[0]?.context;
    if (context === undefined) throw new Error('fixture context is missing');
    const passes = [...record.resolved.passes, { name: 'second', program: { module: 'other' } }];
    const modern = seal({
      ...record,
      resolved: { ...record.resolved, passes },
      programs: [
        {
          ...primary,
          selections: [
            {
              pass: 'forward',
              context,
              address: 'direct',
              entry: submissionAbi.directEntry,
              abi: submissionAbi,
            },
            { pass: 'second', context },
          ],
        },
      ],
    });
    expect(validateCookedMaterialRecord(modern)).toMatchObject({ ok: false });
  });

  it('rejects ambiguous selections, unpublished passes and unknown context axes', () => {
    const primary = record.programs[0] as MaterialCookProgram;
    const mutations = [
      {
        programs: [primary, { ...primary, specializationKey: 'duplicate' }],
        detail: { actual: 'ambiguous Pass/context selection' },
      },
      {
        resolved: {
          ...record.resolved,
          passes: [...record.resolved.passes, { name: 'missing', program: { module: 'other' } }],
        },
        detail: { actual: 'unpublished Pass' },
      },
      {
        programs: [
          {
            ...primary,
            selections: [
              { pass: 'forward', context: { ...primary.selections[0]?.context, arbitrary: true } },
            ],
          },
        ],
        detail: { field: 'programs[0].selections[0].context.arbitrary' },
      },
    ];
    for (const { detail, ...mutation } of mutations)
      expect(validateCookedMaterialRecord({ ...record, ...mutation })).toMatchObject({
        ok: false,
        error: { detail },
      });
  });

  it('rejects stale manifests after entry or context changes and rejects legacy publication fields', () => {
    const sealed = seal(record);
    const primary = record.programs[0] as MaterialCookProgram;
    for (const mutation of [
      {
        programs: [
          {
            ...primary,
            selections: [
              {
                ...primary.selections[0],
                pass: 'forward',
                context: { ...primary.selections[0]?.context, geometry: 'skinned' },
              },
            ],
          },
        ],
      },
      { schemaVersion: 'material-cook/3' },
      { artifact: primary.artifact },
    ])
      expect(validateCookedMaterialRecord({ ...sealed, ...mutation })).toMatchObject({ ok: false });
  });

  it('rejects missing fields and unsupported schema versions', () => {
    expect(validateCookedMaterialRecord({ ...record, refs: undefined })).toMatchObject({
      ok: false,
      error: { code: 'material-cook-record-invalid' },
    });
    expect(
      validateCookedMaterialRecord({ ...record, schemaVersion: 'material-cook/1' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'material-cook-record-invalid' },
    });
  });

  it('admits the derived Standard layer plan and rejects stale or missing identities', () => {
    const standardPass = { name: 'forward', program: { module: 'forgeax::default-standard-pbr' } };
    const { identity } = deriveStandardLayerPlan(record.resolved.parameters, [standardPass]);
    const standardRecord = seal({
      ...record,
      resolved: { ...record.resolved, passes: [standardPass] },
    });
    expect(
      validateCookedMaterialRecord({
        ...standardRecord,
        receipt: {
          ...standardRecord.receipt,
          derivedInterface: { layoutIdentity: 'sha256:layout', layerPlanIdentity: identity },
        },
      }),
    ).toMatchObject({ ok: true });
    for (const derivedInterface of [
      { layoutIdentity: 'sha256:layout', layerPlanIdentity: 'stale' },
      { layoutIdentity: 'sha256:layout' },
    ]) {
      expect(
        validateCookedMaterialRecord({
          ...standardRecord,
          receipt: { ...standardRecord.receipt, derivedInterface },
        }),
      ).toMatchObject({
        ok: false,
        error: { detail: { field: 'receipt.derivedInterface.layerPlanIdentity' } },
      });
    }
  });

  it('admits a shared deep-frozen ABI once and keeps checking mutable ABIs', () => {
    const primary = record.programs[0] as MaterialCookProgram;
    const context = primary.selections[0]?.context;
    if (context === undefined) throw new Error('missing fixture context');
    const withAbi = (abi: unknown) =>
      seal({
        ...record,
        programs: [
          {
            ...primary,
            selections: [
              { pass: 'forward', context, address: 'direct', entry: 'vs_main', abi },
              {
                pass: 'forward',
                context,
                address: 'scene-index',
                entry: 'vs_scene_index',
                abi,
              },
            ] as MaterialCookProgram['selections'],
          },
        ],
      });
    const frozen = structuredClone(submissionAbi) as Record<string, unknown>;
    const freeze = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    };
    freeze(frozen);
    const shared = withAbi(frozen);
    expect(validateCookedMaterialRecord(shared).ok).toBe(true);
    expect(validateCookedMaterialRecord(shared).ok).toBe(true);
    const mutable = structuredClone(submissionAbi) as Record<string, unknown>;
    const editable = withAbi(mutable);
    expect(validateCookedMaterialRecord(editable).ok).toBe(true);
    mutable.materialRow = { addressUnitBytes: 16, byteLength: 15, fields: [] };
    expect(validateCookedMaterialRecord(editable)).toMatchObject({
      ok: false,
      error: { detail: { field: 'programs[0].selections[0].abi' } },
    });
    const invalidFrozen = { ...frozen, materialRow: Object.freeze({ byteLength: 15 }) };
    Object.freeze(invalidFrozen);
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(validateCookedMaterialRecord(withAbi(invalidFrozen)).ok).toBe(false);
  });
});
