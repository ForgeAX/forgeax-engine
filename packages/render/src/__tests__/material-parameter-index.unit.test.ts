import { World } from '@forgeax/engine-ecs';
import type { BindGroup, BindGroupEntry, TextureView } from '@forgeax/engine-rhi';
import { createStandardPbrArtifactReceipt, ShaderRegistry } from '@forgeax/engine-shader';
import { type ParamSchemaEntry, ParamSchemaProjectionOwner } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { resolveMaterialShaderArtifact } from '../assembly/material/assembly';
import { buildBindGroupLayoutDescriptor } from '../pbr-pipeline';
import {
  buildPerSubmeshMaterialBg,
  type PerSubmeshMaterialBgDeps,
} from '../record/main-pass-material';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import type { MaterialSnapshot } from '../render-system-extract';
import type { RenderTargetTextureSource } from '../targets/contracts';
import type { MaterialTextureSource } from '../textures/canvas-texture';

const SHA_MEDIUM_SHADER = 'sha256:464bbf-single-layer-medium';

interface TestBindGroupEntry {
  readonly binding: number;
  readonly resource: BindGroupEntry['resource'];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface TestDependencies extends PerSubmeshMaterialBgDeps {
  readonly runtime: Mutable<PerSubmeshMaterialBgDeps['runtime']>;
  readonly pipelineState: Mutable<PerSubmeshMaterialBgDeps['pipelineState']>;
  readonly bindGroupEntries: Array<readonly TestBindGroupEntry[]>;
}

const entriesByBindGroup = new WeakMap<object, readonly TestBindGroupEntry[]>();
const latestBindGroups = new WeakMap<Array<readonly TestBindGroupEntry[]>, BindGroup>();

function buildMaterialBg(...args: Parameters<typeof buildPerSubmeshMaterialBg>): BindGroup {
  const result = buildPerSubmeshMaterialBg(...args);
  latestBindGroups.set((args[0] as TestDependencies).bindGroupEntries, result);
  return result;
}

function dependencies(
  options: { readonly selectedShader?: string; readonly surfaceResources?: boolean } = {},
): TestDependencies {
  const resource = () => ({}) as never;
  const bindGroupEntries: Array<readonly TestBindGroupEntry[]> = [];
  const runtime = {
    device: {
      caps: { storageBuffer: false },
      limits: { maxSampledTexturesPerShaderStage: 16 },
      createBindGroup: (descriptor: { readonly entries: readonly TestBindGroupEntry[] }) => {
        bindGroupEntries.push(descriptor.entries);
        const value = resource();
        entriesByBindGroup.set(value, descriptor.entries);
        return { ok: true, value };
      },
    },
    ...(options.selectedShader === SHA_MEDIUM_SHADER
      ? {
          getMaterialShaderArtifact: (shaderId: string) =>
            shaderId === SHA_MEDIUM_SHADER
              ? ({ receipt: { surface: { model: 'single-layer-medium' } } } as never)
              : undefined,
        }
      : {}),
  };
  const pipelineState = {
    materialBindGroupLayout: resource(),
    materialUniformBuffer: { buffer: resource() },
    meshStorageBuffer: { buffer: resource() },
    viewUniformBuffer: resource(),
    defaultSampler: resource(),
    defaultWhiteTextureView: resource(),
    defaultNormalTextureView: resource(),
    fallbackTextureView: resource(),
    defaultAnisotropyTextureView: resource(),
    ...(options.surfaceResources ? { surfaceMediumDepthSampler: resource() } : {}),
  };
  const deps = {
    runtime,
    pipelineState,
    world: new World(),
    store: { materialResourceEpoch: 0 },
    materialSlice: 256,
    videoHighPerfAvailable: false,
    skylightResources: {
      irradianceView: resource(),
      irradianceSampler: resource(),
      prefilterView: resource(),
      skylightPrefilterView: resource(),
      prefilterSampler: resource(),
      brdfLutView: resource(),
      intensityBuffer: resource(),
    },
    materialBgShared: new Map(),
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    bindGroupCounts: { createBindGroup: 0, keys: [] },
    frameState: {},
    ...(options.surfaceResources
      ? {
          surfaceRawDepthView: resource(),
          surfaceNearestLayerView: resource(),
          surfaceNearestDepthView: resource(),
        }
      : {}),
    bindGroupEntries,
  };
  return deps as unknown as TestDependencies;
}

function customDependencies(schema: readonly ParamSchemaEntry[]): TestDependencies {
  const deps = dependencies();
  deps.runtime.getParamSchema = () => schema;
  deps.runtime.getMaterialBindGroupLayout = () => deps.pipelineState.materialBindGroupLayout;
  deps.pipelineState.defaultWhite3dTextureView = Object.assign({} as TextureView, {
    label: 'white3d',
  });
  deps.pipelineState.defaultWhite2dArrayTextureView = Object.assign({} as TextureView, {
    label: 'whitearray',
  });
  deps.pipelineState.skylightFallback = { prefilterView: { label: 'whitecube' } } as never;
  return deps;
}

function snapshot(): MaterialSnapshot {
  return { materialShaderId: 'test::custom' } as MaterialSnapshot;
}

function textureValues(deps: TestDependencies, count: number): unknown[] {
  const group = latestBindGroups.get(deps.bindGroupEntries);
  return (group === undefined ? [] : (entriesByBindGroup.get(group) ?? []))
    .slice(1, 1 + count * 2)
    .filter((entry) => entry.resource.kind === 'textureView')
    .map((entry) => (entry.resource.kind === 'textureView' ? entry.resource.value : undefined));
}

describe('material parameter selection complexity', () => {
  it.each([
    { primaryBackdrop: false, variantBackdrop: undefined },
    { primaryBackdrop: true, variantBackdrop: false },
    { primaryBackdrop: false, variantBackdrop: true },
  ])('keeps layout and recording aligned for $primaryBackdrop / $variantBackdrop declarations', async ({
    primaryBackdrop,
    variantBackdrop,
  }) => {
    const shaderId = 'game::shared-material-layout';
    const schema: readonly ParamSchemaEntry[] = [{ name: 'baseColorTexture', type: 'texture2d' }];
    const source = (backdrop: boolean) => `
      @group(1) @binding(6) var shared: sampler;
      ${backdrop ? '@group(1) @binding(9) var backdrop: sampler;' : ''}
    `;
    const receipt = createStandardPbrArtifactReceipt(false);
    const registry = new ShaderRegistry({
      manifestUrl: 'test://shared-layout',
      readText: async () =>
        JSON.stringify({
          entries: [],
          materialShaders:
            variantBackdrop === undefined
              ? []
              : [
                  {
                    identifier: shaderId,
                    sourcePath: 'shared-layout.wgsl',
                    composedWgsl: source(primaryBackdrop),
                    paramSchema: JSON.stringify(schema),
                    variants: [
                      {
                        definesKey: 'TRANSMISSION_AVAILABLE=false',
                        defines: { TRANSMISSION_AVAILABLE: false },
                        composedWgsl: source(variantBackdrop),
                        receipt,
                      },
                    ],
                  },
                ],
        }),
    });
    expect((await registry.loadManifest()).ok).toBe(true);
    registry.installMaterialArtifact(shaderId, {
      source: source(primaryBackdrop),
      paramSchema: schema,
      ...(variantBackdrop === undefined ? {} : { receipt }),
    });
    const admitted = registry.findMaterialArtifact(shaderId).unwrap().paramSchema;
    const deps = customDependencies(admitted);
    Object.assign(deps.runtime.device.limits, { maxSampledTexturesPerShaderStage: 24 });
    deps.runtime.shaderRegistry = registry;
    deps.runtime.getMaterialShaderArtifact = (id) => resolveMaterialShaderArtifact(id, registry);
    const artifact = deps.runtime.getMaterialShaderArtifact(shaderId);
    if (variantBackdrop === undefined) expect(artifact).toBeUndefined();
    else expect(artifact?.program.source).toBe(source(variantBackdrop));
    buildMaterialBg(deps, { materialShaderId: shaderId } as MaterialSnapshot, 1);
    const layout = buildBindGroupLayoutDescriptor(
      {
        shader: { id: shaderId, passKind: 'forward', variantSet: undefined },
        attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
        geometry: { topology: 'triangle-list', vertexLayout: {} },
        renderState: undefined,
      },
      {
        kind: 'pbr-material-merged',
        registry,
        caps: { storageBuffer: false, transmissionBackdrop: true },
      },
    );
    const recorded = deps.bindGroupEntries[0];
    expect(recorded?.map((entry) => entry.binding).sort((a, b) => a - b)).toEqual(
      layout.entries.map((entry) => entry.binding).sort((a, b) => a - b),
    );
    expect(recorded?.some((entry) => entry.binding === 9)).toBe(variantBackdrop !== undefined);
  });

  it('binds cooked physical maps at the same fixed slots as their admitted layout', () => {
    const shaderId = 'sha256:462a87f1';
    const schema = new ParamSchemaProjectionOwner().admit({
      ownerId: shaderId,
      revision: 1,
      schema: [
        ...[
          'baseColorTexture',
          'metallicRoughnessTexture',
          'normalTexture',
          'emissiveTexture',
          'occlusionTexture',
        ].map((name) => ({ name, type: 'texture2d' as const })),
        { name: 'clearcoatTexture', type: 'texture2d' },
      ],
    }).schema;
    const deps = customDependencies(schema);
    buildMaterialBg(deps, { materialShaderId: shaderId } as MaterialSnapshot, 1);
    const layout = buildBindGroupLayoutDescriptor(
      {
        shader: { id: shaderId, passKind: 'forward', variantSet: undefined },
        attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
        geometry: { topology: 'triangle-list', vertexLayout: {} },
        renderState: undefined,
      },
      {
        kind: 'pbr-material-merged',
        materialParamSchema: schema,
        caps: { storageBuffer: false, transmissionBackdrop: false },
      },
    );
    const entries = deps.bindGroupEntries[0];
    if (entries === undefined) throw new Error('Material bind group was not created');
    for (const expected of layout.entries) {
      const actual = entries.find((entry) => entry.binding === expected.binding);
      const kind =
        expected.texture === undefined
          ? expected.sampler === undefined
            ? 'buffer'
            : 'sampler'
          : 'textureView';
      expect(actual?.resource.kind, `binding ${expected.binding}`).toBe(kind);
    }
    expect(entries.find((entry) => entry.binding === 11)?.resource.value).toBe(
      deps.skylightResources.irradianceView,
    );
    expect(entries.find((entry) => entry.binding === 12)?.resource.value).toBe(
      deps.skylightResources.irradianceSampler,
    );
    expect(entries.find((entry) => entry.binding === 48)?.resource.value).toBe(
      deps.pipelineState.defaultSampler,
    );
    expect(entries.find((entry) => entry.binding === 49)?.resource.value).toBe(
      deps.pipelineState.defaultWhiteTextureView,
    );
  });

  it('retains per-field reads for unadmitted compatibility schemas', () => {
    let reads = 0;
    const numericCount = 96;
    const textureCount = 32;
    const schema: ParamSchemaEntry[] = Array.from(
      { length: numericCount + textureCount },
      (_, index) => ({
        get name() {
          reads += 1;
          return `field${index}`;
        },
        type: index < numericCount ? 'f32' : 'texture2d',
      }),
    );
    const deps = customDependencies(schema);
    buildMaterialBg(deps, snapshot(), 1);
    reads = 0;
    for (let view = 0; view < 3; view += 1) buildMaterialBg(deps, snapshot(), view + 2);
    expect(textureValues(deps, textureCount)).toHaveLength(textureCount);
    // Each build validates the mutable layout once, then preserves per-field reads.
    expect(reads).toBe(21600 + schema.length * 3);
  });

  it('uses an admitted type index for all views without schema.find', () => {
    const owner = new ParamSchemaProjectionOwner();
    const admitted = owner.admit({
      ownerId: 'indexed',
      revision: 1,
      schema: [
        ...Array.from({ length: 96 }, (_, index) => ({
          name: `numeric${index}`,
          type: 'f32' as const,
        })),
        ...Array.from({ length: 32 }, (_, index) => ({
          name: `texture${index}`,
          type: 'texture2d' as const,
        })),
      ],
    });
    const deps = customDependencies(admitted.schema);
    const original = Array.prototype.find;
    let visits = 0;
    const spy = vi.spyOn(Array.prototype, 'find').mockImplementation(function (
      this: unknown[],
      predicate: (value: unknown, index: number, array: unknown[]) => unknown,
      thisArg?: unknown,
    ) {
      if (this === admitted.schema) visits += 1;
      return original.call(this, predicate, thisArg);
    });
    try {
      for (let view = 0; view < 3; view++) buildMaterialBg(deps, snapshot(), view);
      expect(textureValues(deps, 32)).toHaveLength(32);
      expect(visits).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves dimension fallbacks, mutable edits and current view resources', () => {
    const schema: ParamSchemaEntry[] = [
      { name: 'cube', type: 'texture_cube' },
      { name: 'volume', type: 'texture3d' },
      { name: 'array', type: 'texture2d_array' },
      { name: 'normalTexture', type: 'texture2d' },
      { name: 'baseColorTexture', type: 'texture2d' },
      { name: 'anisotropyTexture', type: 'texture2d' },
    ];
    const deps = customDependencies(schema);
    buildMaterialBg(deps, snapshot(), 1);
    expect(textureValues(deps, 6)).toEqual([
      deps.pipelineState.skylightFallback?.prefilterView,
      deps.pipelineState.defaultWhite3dTextureView,
      deps.pipelineState.defaultWhite2dArrayTextureView,
      deps.pipelineState.defaultNormalTextureView,
      deps.pipelineState.fallbackTextureView,
      deps.pipelineState.defaultAnisotropyTextureView,
    ]);
    schema[0] = { name: 'cube', type: 'texture2d' };
    const replacement = {} as TextureView;
    deps.pipelineState.defaultWhite3dTextureView = replacement;
    buildMaterialBg(deps, snapshot(), 2);
    expect(textureValues(deps, 6).slice(0, 2)).toEqual([
      deps.pipelineState.defaultWhiteTextureView,
      replacement,
    ]);
  });

  it('rechecks unadmitted texture membership and order after in-place schema edits', () => {
    const schema: ParamSchemaEntry[] = [{ name: 'first', type: 'texture_cube' }];
    const deps = customDependencies(schema);
    buildMaterialBg(deps, snapshot(), 1);
    expect(textureValues(deps, 1)).toEqual([deps.pipelineState.skylightFallback?.prefilterView]);
    schema[0] = { name: 'renamed', type: 'texture3d' };
    schema.push({ name: 'second', type: 'texture2d_array' });
    buildMaterialBg(deps, snapshot(), 2);
    expect(textureValues(deps, 2)).toEqual([
      deps.pipelineState.defaultWhite3dTextureView,
      deps.pipelineState.defaultWhite2dArrayTextureView,
    ]);
    schema.splice(0, 1);
    buildMaterialBg(deps, snapshot(), 3);
    expect(textureValues(deps, 1)).toEqual([deps.pipelineState.defaultWhite2dArrayTextureView]);
    schema.push({ name: 'second', type: 'texture2d' });
    expect(() => buildMaterialBg(deps, snapshot(), 4)).toThrow('duplicate');
  });

  it('observes a default sampler replaced by the current texture resolver', () => {
    const deps = customDependencies([{ name: 'external', type: 'texture2d' }]);
    const replacement = {} as typeof deps.pipelineState.defaultSampler;
    const view = {} as TextureView;
    deps.runtime.externalTextures = {
      resolve: () => {
        deps.pipelineState.defaultSampler = replacement;
        return { kind: 'textureView', value: view };
      },
      importVideoFrame: () => undefined,
    };
    buildMaterialBg(
      deps,
      {
        ...snapshot(),
        textureSources: new Map([['external', { externalTextureId: 1 }]]),
      } as MaterialSnapshot,
      1,
    );
    expect(deps.bindGroupEntries[0]?.[1]?.resource).toEqual({
      kind: 'sampler',
      value: replacement,
    });
    expect(deps.bindGroupEntries[0]?.[1]?.resource.value).toBe(replacement);
    expect(textureValues(deps, 1)).toEqual([view]);
  });

  it('retains per-view target receipt fallback and external-slot admission', () => {
    const schema: ParamSchemaEntry[] = [
      { name: 'target', type: 'texture_cube' },
      { name: 'external', type: 'texture_external' },
    ];
    const deps = customDependencies(schema);
    const targetSource = {} as RenderTargetTextureSource;
    const externalSource = { externalTextureId: 1 };
    let targetView: TextureView | undefined = {} as TextureView;
    let targetDimension = 'cube';
    const flags: boolean[] = [];
    const externalView = {} as TextureView;
    deps.runtime.externalTextures = {
      resolve: (_source, slotExternal) => {
        flags.push(slotExternal);
        return { kind: 'textureView', value: externalView };
      },
      importVideoFrame: () => undefined,
    };
    const targetDeps = {
      ...deps,
      resolveRenderTargetTextureSource: () =>
        ({
          source: targetSource,
          target: {},
          generation: 1,
          shape: 'cube',
          format: 'rgba8unorm',
          view: { dimension: targetDimension, mipLevel: 0, resolveRequired: false },
          ...(targetView === undefined ? {} : { textureView: targetView }),
        }) as never,
    };
    const material = {
      ...snapshot(),
      textureSources: new Map<string, MaterialTextureSource>([
        ['target', targetSource],
        ['external', externalSource],
      ]),
    } as MaterialSnapshot;
    buildMaterialBg(targetDeps, material, 1);
    expect(textureValues(deps, 2)).toEqual([targetView, externalView]);
    targetView = undefined;
    buildMaterialBg(targetDeps, material, 2);
    expect(textureValues(deps, 2)).toEqual([
      deps.pipelineState.skylightFallback?.prefilterView,
      externalView,
    ]);
    targetView = {} as TextureView;
    targetDimension = '2d';
    schema[1] = { name: 'external', type: 'texture2d' };
    buildMaterialBg(targetDeps, material, 3);
    expect(textureValues(deps, 2)).toEqual([
      deps.pipelineState.skylightFallback?.prefilterView,
      externalView,
    ]);
    expect(flags).toEqual([true, true, false]);
    schema[0] = { name: 'target', type: 'texture2d' };
    buildMaterialBg(targetDeps, material, 4);
    expect(textureValues(deps, 2)).toEqual([targetView, externalView]);
  });

  it('observes a later unadmitted field edited by the current target resolver', () => {
    const trace: string[] = [];
    const schema: ParamSchemaEntry[] = [
      { name: 'target', type: 'texture_cube' },
      { name: 'later', type: 'texture_cube' },
    ];
    const deps = customDependencies(schema);
    const targetSource = {} as RenderTargetTextureSource;
    const targetView = {} as TextureView;
    const material = {
      ...snapshot(),
      textureSources: new Map<string, MaterialTextureSource>([['target', targetSource]]),
    } as MaterialSnapshot;
    const targetDeps = {
      ...deps,
      resolveRenderTargetTextureSource: () => {
        trace.push('resolve-target');
        schema[1] = { name: 'later', type: 'texture3d' };
        return {
          source: targetSource,
          target: {},
          generation: 1,
          shape: 'cube',
          format: 'rgba8unorm',
          view: { dimension: 'cube', mipLevel: 0, resolveRequired: false },
          textureView: targetView,
        } as never;
      },
    };
    buildMaterialBg(targetDeps, material, 1);
    expect(trace).toEqual(['resolve-target']);
    const views = textureValues(deps, 2);
    expect(views[0]).toBe(targetView);
    expect(views[1]).toBe(deps.pipelineState.defaultWhite3dTextureView);
  });

  it('rechecks the current unadmitted parameter after the target resolver', () => {
    const trace: string[] = [];
    let currentType: 'texture_cube' | 'texture3d' = 'texture_cube';
    const schema: ParamSchemaEntry[] = [
      {
        name: 'target',
        get type() {
          trace.push(`type:${currentType}`);
          return currentType;
        },
      },
    ];
    const deps = customDependencies(schema);
    const targetSource = {} as RenderTargetTextureSource;
    const targetView = {} as TextureView;
    const material = {
      ...snapshot(),
      textureSources: new Map<string, MaterialTextureSource>([['target', targetSource]]),
    } as MaterialSnapshot;
    buildMaterialBg(
      {
        ...deps,
        resolveRenderTargetTextureSource: () => {
          trace.push('resolve-target');
          currentType = 'texture3d';
          return {
            source: targetSource,
            target: {},
            generation: 1,
            shape: 'cube',
            format: 'rgba8unorm',
            view: { dimension: 'cube', mipLevel: 0, resolveRequired: false },
            textureView: targetView,
          } as never;
        },
      },
      material,
      1,
    );
    expect(trace.at(-2)).toBe('resolve-target');
    expect(trace.at(-1)).toBe('type:texture3d');
    expect(textureValues(deps, 1)[0]).toBe(deps.pipelineState.skylightFallback?.prefilterView);
    expect(textureValues(deps, 1)[0]).not.toBe(targetView);
  });

  it('retains repeated type accessor reads in an unadmitted default-view fallback', () => {
    const trace: string[] = [];
    const schema: ParamSchemaEntry[] = [
      {
        name: 'field',
        get type() {
          const type = trace.length < 2 ? 'texture2d' : 'texture3d';
          trace.push(type);
          return type;
        },
      },
    ];
    const deps = customDependencies(schema);
    buildMaterialBg(deps, snapshot(), 1);
    expect(textureValues(deps, 1)[0]).toBe(deps.pipelineState.defaultWhite3dTextureView);
    expect(trace).toEqual(['texture2d', 'texture2d', 'texture3d', 'texture3d']);
  });

  it('retains cold unadmitted scan counts and the zero-texture control', () => {
    const reads: number[] = [];
    for (const textureCount of [0, 1, 16]) {
      let names = 0;
      const schema: ParamSchemaEntry[] = Array.from({ length: 64 + textureCount }, (_, index) => ({
        get name() {
          names += 1;
          return `unique${textureCount}_${index}`;
        },
        type: index < 64 ? 'f32' : 'texture2d',
      }));
      const deps = customDependencies(schema);
      buildMaterialBg(deps, snapshot(), 1);
      expect(textureValues(deps, textureCount)).toHaveLength(textureCount);
      expect(names).toBe(schema.length + textureCount * (129 + textureCount));
      reads.push(names);
    }
    expect(reads[0]).toBe(64);
  });

  it('does not add a source scan for a cold unique schema with its sole texture first', () => {
    let reads = 0;
    const schema: ParamSchemaEntry[] = Array.from({ length: 65 }, (_, index) => ({
      get name() {
        reads += 1;
        return `early${index}`;
      },
      type: index === 0 ? 'texture2d' : 'f32',
    }));
    const deps = customDependencies(schema);
    buildMaterialBg(deps, snapshot(), 1);
    expect(textureValues(deps, 1)).toHaveLength(1);
    expect(reads).toBe(67);
  });

  it('keeps immutable revision replacement independent of its prior projection', () => {
    const owner = new ParamSchemaProjectionOwner();
    const first = owner.admit({
      ownerId: 'test::custom',
      revision: 1,
      schema: [{ name: 'texture', type: 'texture_cube' }],
    });
    const next = owner.admit({
      ownerId: 'test::custom',
      revision: 2,
      schema: [{ name: 'texture', type: 'texture3d' }],
    });
    const deps = customDependencies(first.schema);
    buildMaterialBg(deps, snapshot(), 1);
    expect(textureValues(deps, 1)).toEqual([deps.pipelineState.skylightFallback?.prefilterView]);
    deps.runtime.getParamSchema = () => next.schema;
    buildMaterialBg(deps, snapshot(), 2);
    expect(textureValues(deps, 1)).toEqual([deps.pipelineState.defaultWhite3dTextureView]);
    deps.runtime.getParamSchema = () => first.schema;
    buildMaterialBg(deps, snapshot(), 3);
    expect(textureValues(deps, 1)).toEqual([deps.pipelineState.skylightFallback?.prefilterView]);
  });
});
