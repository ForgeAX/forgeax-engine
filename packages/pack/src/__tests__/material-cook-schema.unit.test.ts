import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

const record: CookedMaterialRecord = {
  schemaVersion: 'material-cook/4',
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
      selections: [
        {
          pass: 'forward',
          context: {
            backend: 'webgpu',
            capability: 'storage-buffer',
            pipeline: 'forward',
            geometry: 'mesh',
            pass: 'forward',
            profile: 'forgeax-material-wgsl-v1',
            toolchain: 'naga-oil',
            instrumentation: 'none',
          },
        },
      ],
      artifact: {
        mediaType: 'text/wgsl',
        path: 'materials/mat-root/forward.wgsl',
        digest: 'sha256:artifact',
        bytes: new TextEncoder().encode('shader'),
      },
    },
  ],
  receipt: {
    schemaVersion: 'material-cook/4',
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
    const pass = record.resolved.passes[0];
    if (selection === undefined || pass === undefined) throw new Error('missing fixture pass');
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
            {
              ...selection,
              context: { ...selection.context, backend: 'webgl2', capability: 'uniform-fallback' },
            },
          ],
        },
        {
          ...primary,
          specializationKey: 'sha256:a',
          selections: [{ ...selection, context: { ...selection.context, backend: 'wgpu-native' } }],
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

  it('round trips both Surface derivatives through the executable and JSON contracts', () => {
    const base = record.programs[0];
    if (!base) throw new Error('missing base program');
    const derivatives: MaterialCookProgram[] = ['ray-hit', 'card-capture'].map((pass) => ({
      ...base,
      specializationKey: pass,
      selections: [
        {
          pass: 'forward',
          entry: pass === 'ray-hit' ? 'cs_surface' : 'vs_card',
          context: {
            backend: 'webgpu',
            capability: 'storage-buffer',
            pipeline: 'ray',
            geometry: 'mesh',
            pass: pass as 'ray-hit' | 'card-capture',
            profile: 'forgeax-material-ray-v1',
            toolchain: 'naga-oil',
            instrumentation: 'none',
          },
        },
      ],
    }));
    const value = JSON.parse(
      serializeCookedMaterialRecord(seal({ ...record, programs: [base, ...derivatives] })),
    );
    expect(validateCookedMaterialRecord(value)).toMatchObject({ ok: true });
    const schema = JSON.parse(
      readFileSync(new URL('../schema/material-cook.schema.json', import.meta.url), 'utf8'),
    );
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    for (const change of [
      { entry: 'cs_surface' },
      { entry: 'fs_card' },
      { address: 'direct' },
      { abi: submissionAbi },
      { context: { ...derivatives[1]?.selections[0]?.context, pass: 'raster-probe' } },
      { context: { ...derivatives[1]?.selections[0]?.context, visibleSurface: true } },
    ]) {
      const invalid = structuredClone(value);
      Object.assign(invalid.programs[2].selections[0], change);
      expect(validateCookedMaterialRecord(invalid).ok).toBe(false);
      expect(validate(invalid), JSON.stringify(change)).toBe(false);
    }
    const duplicate = structuredClone(value);
    duplicate.programs.push({ ...duplicate.programs[2], specializationKey: 'duplicate-card' });
    expect(validateCookedMaterialRecord(duplicate)).toMatchObject({
      ok: false,
      error: { detail: { actual: 'ambiguous Pass/context selection' } },
    });
  });

  it('validates ray derivatives beside complete raster address pairs', () => {
    const primary = record.programs[0] as MaterialCookProgram;
    const context = primary.selections[0]?.context;
    if (context === undefined) throw new Error('missing fixture context');
    const ray: MaterialCookProgram = {
      ...primary,
      specializationKey: 'ray',
      selections: [
        {
          pass: 'forward',
          entry: 'cs_surface',
          context: {
            backend: 'webgpu',
            capability: 'storage-buffer',
            pipeline: 'ray',
            geometry: 'mesh',
            pass: 'ray-hit',
            profile: 'forgeax-material-ray-v1',
            toolchain: 'naga-oil',
            instrumentation: 'none',
          },
        },
      ],
    };
    const raster: MaterialCookProgram = {
      ...primary,
      selections: [
        {
          pass: 'forward',
          context,
          address: 'direct',
          entry: submissionAbi.directEntry,
          abi: submissionAbi,
        },
        {
          pass: 'forward',
          context,
          address: 'scene-index',
          entry: submissionAbi.sceneIndexEntry,
          abi: submissionAbi,
        },
      ],
    };
    const modern = seal({ ...record, programs: [raster, ray] });
    expect(validateCookedMaterialRecord(JSON.parse(serializeCookedMaterialRecord(modern))).ok).toBe(
      true,
    );
    for (const change of [
      { address: 'direct' },
      { abi: submissionAbi },
      { entry: 'vs_main' },
      { context: { ...ray.selections[0]?.context, visibleSurface: true } },
      { context: { ...ray.selections[0]?.context, backend: 'webgl2' } },
      { context: { ...ray.selections[0]?.context, geometry: 'skinned' } },
    ]) {
      expect(
        validateCookedMaterialRecord({
          ...modern,
          programs: [
            raster,
            {
              ...ray,
              selections: [{ ...ray.selections[0], ...change }],
            },
          ],
        }).ok,
      ).toBe(false);
    }
    // A derived ray program cannot satisfy the authored raster pass requirement.
    expect(validateCookedMaterialRecord(seal({ ...record, programs: [ray] }))).toMatchObject({
      ok: false,
      error: { detail: { actual: 'unpublished Pass' } },
    });
    expect(
      validateCookedMaterialRecord({
        ...modern,
        programs: [raster, ray, { ...ray, specializationKey: 'duplicate-ray' }],
      }),
    ).toMatchObject({
      ok: false,
      error: { detail: { actual: 'ambiguous Pass/context selection' } },
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

  it('requires material-cook/4 identity and derived interface association', () => {
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../schema/material-cook.schema.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      properties: Record<
        string,
        { const?: string; required?: string[]; properties?: Record<string, unknown> }
      >;
      required: string[];
    };
    expect(schema.properties.schemaVersion?.const).toBe('material-cook/4');
    expect(schema.properties.receipt?.required).toEqual(
      expect.arrayContaining(['identity', 'derivedInterface']),
    );
    expect(schema.properties.receipt?.properties?.derivedInterface).toBeDefined();
  });

  it('defines the v4 identity, provenance, and generation contract', () => {
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../schema/material-cook.schema.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      properties: Record<
        string,
        { const?: string; required?: string[]; properties?: Record<string, unknown> }
      >;
    };
    expect(schema.properties.schemaVersion?.const).toBe('material-cook/4');
    expect(schema.properties.receipt?.properties?.identity).toMatchObject({
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
    });
    expect(schema.properties.receipt?.required).toEqual(
      expect.arrayContaining(['identity', 'derivedInterface']),
    );
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
    const selection = {
      ...primary.selections[0],
      pass: 'second',
    } as MaterialCookProgram['selections'][number];
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
          selections: [selection],
        },
      ],
    });
    expect(validateCookedMaterialRecord(distinct)).toMatchObject({ ok: true });
    const shared = seal({
      ...distinct,
      programs: [{ ...primary, selections: [...primary.selections, selection] }],
    });
    expect(validateCookedMaterialRecord(shared)).toMatchObject({ ok: true });
  });

  it('keeps direct and scene-index selections unique under one published ABI', () => {
    const primary = record.programs[0] as MaterialCookProgram;
    const context = primary.selections[0]?.context;
    if (context === undefined) throw new Error('fixture context is missing');
    const modern = seal({
      ...record,
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
            {
              pass: 'forward',
              context,
              address: 'scene-index',
              entry: submissionAbi.sceneIndexEntry,
              abi: submissionAbi,
            },
          ],
        },
      ],
    });
    expect(validateCookedMaterialRecord(modern)).toMatchObject({ ok: true });
    expect(
      validateCookedMaterialRecord({
        ...modern,
        programs: [{ ...modern.programs[0], selections: [modern.programs[0]?.selections[0]] }],
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
    const schema = JSON.parse(
      readFileSync(new URL('../schema/material-cook.schema.json', import.meta.url), 'utf8'),
    );
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(
      validate(JSON.parse(serializeCookedMaterialRecord(directOnly))),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(
      validateCookedMaterialRecord(JSON.parse(serializeCookedMaterialRecord(directOnly))).ok,
    ).toBe(true);
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
    expect(validateCookedMaterialRecord(modern)).toMatchObject({
      ok: false,
      error: {
        detail: {
          actual: expect.stringContaining('modern material publications require address'),
        },
      },
    });
  });

  it('rejects ambiguous selections, unpublished passes and unknown context axes', () => {
    const primary = record.programs[0] as MaterialCookProgram;
    expect(
      validateCookedMaterialRecord({
        ...record,
        programs: [primary, { ...primary, specializationKey: 'duplicate' }],
      }),
    ).toMatchObject({
      ok: false,
      error: { detail: { actual: 'ambiguous Pass/context selection' } },
    });
    expect(
      validateCookedMaterialRecord({
        ...record,
        resolved: {
          ...record.resolved,
          passes: [...record.resolved.passes, { name: 'missing', program: { module: 'other' } }],
        },
      }),
    ).toMatchObject({ ok: false, error: { detail: { actual: 'unpublished Pass' } } });
    expect(
      validateCookedMaterialRecord({
        ...record,
        programs: [
          {
            ...primary,
            selections: [
              { pass: 'forward', context: { ...primary.selections[0]?.context, arbitrary: true } },
            ],
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      error: { detail: { field: 'programs[0].selections[0].context.arbitrary' } },
    });
  });

  it('rejects stale manifests after entry or context changes and rejects legacy publication fields', () => {
    const sealed = seal(record);
    expect(
      validateCookedMaterialRecord({
        ...sealed,
        resolved: {
          ...sealed.resolved,
          passes: [{ name: 'forward', program: { module: 'core/pbr', fragmentEntry: 'fs_other' } }],
        },
      }),
    ).toMatchObject({ ok: false, error: { detail: { field: 'receipt.identity.artifactDigest' } } });
    const primary = record.programs[0] as MaterialCookProgram;
    expect(
      validateCookedMaterialRecord({
        ...sealed,
        programs: [
          {
            ...primary,
            selections: [
              {
                pass: 'forward',
                context: { ...primary.selections[0]?.context, geometry: 'skinned' },
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { detail: { field: 'receipt.identity.artifactDigest' } } });
    expect(
      validateCookedMaterialRecord({ ...sealed, schemaVersion: 'material-cook/3' }),
    ).toMatchObject({ ok: false });
    expect(validateCookedMaterialRecord({ ...sealed, artifact: primary.artifact })).toMatchObject({
      ok: false,
    });
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

  it('rejects a Standard record whose receipt layer plan is stale', () => {
    const standardPass = { name: 'forward', program: { module: 'forgeax::default-standard-pbr' } };
    const standardPlan = deriveStandardLayerPlan(record.resolved.parameters, [standardPass]);
    const standardRecord = seal({
      ...record,
      resolved: { ...record.resolved, passes: [standardPass] },
      receipt: {
        ...record.receipt,
        derivedInterface: {
          layoutIdentity: 'sha256:layout',
          layerPlanIdentity: standardPlan.identity,
        },
      },
    });
    expect(validateCookedMaterialRecord(standardRecord)).toMatchObject({ ok: true });
    expect(
      validateCookedMaterialRecord({
        ...standardRecord,
        receipt: {
          ...standardRecord.receipt,
          derivedInterface: { layoutIdentity: 'sha256:layout', layerPlanIdentity: 'stale' },
        },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        detail: { field: 'receipt.derivedInterface.layerPlanIdentity' },
      },
    });
  });

  it('rejects a Standard record whose receipt omits the layer plan identity', () => {
    const standardPass = { name: 'forward', program: { module: 'forgeax::default-standard-pbr' } };
    const standardPlan = deriveStandardLayerPlan(record.resolved.parameters, [standardPass]);
    const standardRecord = seal({
      ...record,
      resolved: { ...record.resolved, passes: [standardPass] },
      receipt: {
        ...record.receipt,
        derivedInterface: {
          layoutIdentity: 'sha256:layout',
          layerPlanIdentity: standardPlan.identity,
        },
      },
    });
    expect(
      validateCookedMaterialRecord({
        ...standardRecord,
        receipt: {
          ...standardRecord.receipt,
          derivedInterface: { layoutIdentity: 'sha256:layout' },
        },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        detail: { field: 'receipt.derivedInterface.layerPlanIdentity' },
      },
    });
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
