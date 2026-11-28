import { World } from '@forgeax/engine-ecs';
import {
  createMaterialShaderProgram,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { derive, err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { projectSurfaceMaterialBindings, retainProjectedMaterialSlots } from '../pbr-pipeline';
import {
  buildPerSubmeshMaterialBg,
  type MaterialBindingAddress,
  type PerSubmeshMaterialBgDeps,
} from '../record/main-pass-material';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import { defaultMaterialSnapshot } from '../render-system-extract';

const SHA_MEDIUM_SHADER = 'sha256:464bbf-single-layer-medium';

interface TestBindGroupEntry {
  readonly binding: number;
}

interface TestDependencies extends PerSubmeshMaterialBgDeps {
  readonly bindGroupEntries: Array<readonly TestBindGroupEntry[]>;
}

function dependencies(
  options: { readonly selectedShader?: string; readonly surfaceResources?: boolean } = {},
): TestDependencies {
  const resource = () => ({}) as never;
  const bindGroupEntries: Array<readonly TestBindGroupEntry[]> = [];
  const runtime = {
    device: {
      queue: { writeBuffer: () => ({ ok: true, value: undefined, unwrap: () => undefined }) },
      caps: { storageBuffer: false },
      limits: { maxSampledTexturesPerShaderStage: 16 },
      createBindGroup: (descriptor: { readonly entries: readonly TestBindGroupEntry[] }) => {
        bindGroupEntries.push(descriptor.entries);
        return { ok: true, value: resource() };
      },
    },
    ...(options.selectedShader === SHA_MEDIUM_SHADER
      ? {
          shaderRegistry: {
            materialArtifactDeclaration: () => undefined,
            findMaterialArtifact: (shaderId: string) =>
              shaderId !== SHA_MEDIUM_SHADER
                ? err(new Error('Unknown selected shader'))
                : ok({
                    paramSchema: [],
                    receipt: { surface: { model: 'single-layer-medium' } },
                    program: createMaterialShaderProgram(
                      `
                  @group(1) @binding(${derive([]).userRegionBindingEnd + 9}) var rawDepth: texture_2d<f32>;
                  @fragment fn fs_main() -> @location(0) vec4<f32> {
                    return textureLoad(rawDepth, vec2<i32>(0), 0);
                  }
                `,
                      [
                        {
                          name: 'fs_main',
                          stage: 'fragment',
                          bindings: [{ group: 1, binding: derive([]).userRegionBindingEnd + 9 }],
                        },
                      ],
                    ),
                  }),
            materialShaderManifestEntry: () => undefined,
          },
        }
      : {}),
  };
  const materialBindGroupLayout = resource();
  if (options.selectedShader === SHA_MEDIUM_SHADER) {
    // Bind-group assembly consumes the slots retained during layout creation.
    const registry = (runtime as unknown as TestDependencies['runtime']).shaderRegistry;
    const entries = [{ binding: 0 }, { binding: derive([]).userRegionBindingEnd + 9 }];
    retainProjectedMaterialSlots(
      materialBindGroupLayout,
      projectSurfaceMaterialBindings(entries, registry, SHA_MEDIUM_SHADER),
    );
  }
  const pipelineState = {
    skylightFallback: null,
    materialBindGroupLayout,
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
      skySh: resource(),
      irradianceSampler: resource(),
      prefilterView: resource(),
      prefilterSampler: resource(),
      brdfLutView: resource(),
      intensityBuffer: resource(),
    },
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

function mediumSnapshot() {
  return {
    ...defaultMaterialSnapshot(),
    materialShaderId: 'forgeax::selected-shadow',
    surfaceModel: 'single-layer-medium',
  } as never;
}

describe('main-pass Surface material selection', () => {
  it('publishes the selected primitive reflection from the material binding source revision', () => {
    const deps = dependencies();
    const world = {
      identity: 'scene',
      assetRevision: () => 7,
    } as unknown as PerSubmeshMaterialBgDeps['world'];
    const ready = { ...deps.skylightResources };
    const resolveProbe = vi.fn<
      NonNullable<PerSubmeshMaterialBgDeps['resolveReflectionProbeResources']>
    >((source) => {
      expect(source.assetRevision(19)).toBe(4);
      return { resources: ready, probeIndex: 1 };
    });
    Object.assign(deps, { resolveReflectionProbeResources: resolveProbe });
    const material = {
      ...defaultMaterialSnapshot(),
      materialHandle: 19,
      materialShaderId: 'forgeax::default-standard-pbr',
      materialParamSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
      sourceAssets: {
        root: 19,
        revision: 4,
        assets: [{ handle: 19, revision: 4, value: { kind: 'Material' } }],
      },
    } as Parameters<typeof buildPerSubmeshMaterialBg>[1];
    const address: MaterialBindingAddress = {
      byteOffset: 0,
      dynamicOffsetCount: 1,
      reflection: undefined,
    };
    const bind = () =>
      buildPerSubmeshMaterialBg(
        deps,
        material,
        4,
        world,
        undefined,
        0,
        'class',
        0,
        undefined,
        address,
      );
    const first = bind();
    expect(address.reflection).toBe(ready);
    expect(resolveProbe).toHaveBeenCalledExactlyOnceWith(expect.any(Object), 4, 'class');
    resolveProbe.mockImplementationOnce(() => undefined);
    expect(bind()).toBe(first);
    expect(address.reflection).toBe(deps.skylightResources);
  });

  it('shares only immutable empty prepared-resource facts between independent assemblies', () => {
    const deps = dependencies();
    for (const materialHandle of [27, 28])
      buildPerSubmeshMaterialBg(deps, { ...defaultMaterialSnapshot(), materialHandle } as never, 4);
    const entries = [...deps.materialBgAssemblyCache.values()];
    expect(entries).toHaveLength(2);
    expect(entries[0]?.preparedTextures).toEqual([]);
    expect(entries[0]?.preparedTextures).toBe(entries[1]?.preparedTextures);
    expect(Object.isFrozen(entries[0]?.preparedTextures)).toBe(true);
  });

  it('keeps an opaque assembly when the pass supplies unused Surface depth resources', () => {
    const deps = dependencies({ surfaceResources: true });
    const material = {
      ...defaultMaterialSnapshot(),
      materialHandle: 19,
      materialShaderId: 'forgeax::default-standard-pbr',
      materialParamSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
    };
    const first = buildPerSubmeshMaterialBg(deps, material as never, 4);
    const accepted = deps.materialBgAssemblyCache.values().next().value;
    expect(accepted).toBeDefined();
    Object.assign(deps, { surfaceRawDepthView: {} });
    expect(buildPerSubmeshMaterialBg(deps, material as never, 4)).toBe(first);
    expect(deps.materialBgAssemblyCache.values().next().value).toBe(accepted);
  });

  it('keeps accepted bindings isolated between independent Renderer caches', () => {
    const deps = dependencies();
    const scope = (identity: string) =>
      ({ identity }) as unknown as PerSubmeshMaterialBgDeps['world'];
    const first = {
      ...defaultMaterialSnapshot(),
      materialHandle: 1,
      materialShaderId: 's',
      paramSnapshot: { roughness: 0.5 },
    };
    const second = {
      ...defaultMaterialSnapshot(),
      materialHandle: 7,
      materialShaderId: '1:s',
      paramSnapshot: { roughness: 0.9 },
    };
    const other = dependencies();
    buildPerSubmeshMaterialBg(deps, first as never, 4, scope('w:7'));
    buildPerSubmeshMaterialBg(other, second as never, 4, scope('w'));
    const entries = [
      ...deps.materialBgAssemblyCache.values(),
      ...other.materialBgAssemblyCache.values(),
    ];
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.material)).toEqual([first, second]);
    deps.materialBgAssemblyCache.clear();
    expect([...deps.materialBgAssemblyCache.values()]).toEqual([]);
  });

  it('observes probe and scope getters before shader callbacks on accepted reuse', () => {
    const deps = dependencies();
    const events: string[] = [];
    const world = {
      get identity() {
        events.push('scope');
        return 'scope';
      },
    } as unknown as PerSubmeshMaterialBgDeps['world'];
    Object.assign(deps, {
      resolveReflectionProbeResources: () => {
        events.push('resolve');
        return {
          resources: deps.skylightResources,
          get probeIndex() {
            events.push('probe');
            return 2;
          },
        };
      },
    });
    const findArtifact = vi.fn(() =>
      ok({
        receipt: {
          get surface() {
            events.push('artifact');
            return undefined;
          },
        },
        program: createMaterialShaderProgram(''),
      }),
    );
    Object.assign(deps.runtime, {
      shaderRegistry: {
        materialArtifactDeclaration: () => undefined,
        findMaterialArtifact: findArtifact,
        materialShaderManifestEntry: () => undefined,
      },
      getParamSchema: () => {
        events.push('schema');
        return undefined;
      },
      getMaterialBindGroupLayout: () => {
        events.push('layout');
        return deps.pipelineState.materialBindGroupLayout;
      },
    });
    const material = {
      ...defaultMaterialSnapshot(),
      materialShaderId: 'test',
      get materialHandle() {
        events.push('handle');
        return 17;
      },
    };
    const first = buildPerSubmeshMaterialBg(deps, material as never, 4, world);
    events.length = 0;
    findArtifact.mockClear();
    expect(buildPerSubmeshMaterialBg(deps, material as never, 4, world)).toBe(first);
    // One recording resolves a shader's surface model once; a new recording asks again.
    expect(events).toEqual(['resolve', 'handle', 'probe', 'scope', 'schema', 'layout']);
    // Water fluid admission still reads the registry on every recording.
    expect(findArtifact).toHaveBeenCalledExactlyOnceWith('test');
    events.length = 0;
    findArtifact.mockClear();
    expect(buildPerSubmeshMaterialBg({ ...deps }, material as never, 4, world)).toBe(first);
    expect(events).toEqual(['resolve', 'handle', 'probe', 'scope', 'artifact', 'schema', 'layout']);
    expect(findArtifact).toHaveBeenCalledTimes(2);
    expect(deps.bindGroupEntries).toHaveLength(1);
  });

  it('retains material binding assembly across Worker clones and numeric value updates', () => {
    const deps = dependencies();
    const material = {
      ...defaultMaterialSnapshot(),
      materialHandle: 17,
      materialShaderId: 'forgeax::default-standard-pbr',
      materialParamSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
      paramSnapshot: { roughness: 0.5 },
    };
    const first = buildPerSubmeshMaterialBg(deps, material as never, 4);
    const firstEntry = deps.materialBgAssemblyCache.values().next().value;
    expect(firstEntry).toBeDefined();
    const changed = { ...structuredClone(material), paramSnapshot: { roughness: 0.9 } };
    expect(buildPerSubmeshMaterialBg(deps, changed as never, 4)).toBe(first);
    expect(deps.materialBgAssemblyCache.values().next().value).toBe(firstEntry);
  });

  it('does not request raw depth when a non-medium pass shader is selected', () => {
    expect(() =>
      buildPerSubmeshMaterialBg(
        dependencies(),
        mediumSnapshot(),
        4,
        undefined,
        'forgeax::selected-shadow',
      ),
    ).not.toThrow();
  });

  it('requires raw depth for the selected single-layer-medium shader', () => {
    expect(() =>
      buildPerSubmeshMaterialBg(
        dependencies(),
        mediumSnapshot(),
        4,
        undefined,
        'forgeax::single-layer-medium',
      ),
    ).toThrow('single-layer medium material bind group has producer-owned raw depth');
  });

  it('uses the selected SHA medium artifact ABI instead of authored metadata', () => {
    const missingResources = dependencies({ selectedShader: SHA_MEDIUM_SHADER });
    expect(() =>
      buildPerSubmeshMaterialBg(
        missingResources,
        mediumSnapshot(),
        4,
        undefined,
        SHA_MEDIUM_SHADER,
      ),
    ).toThrow('single-layer medium material bind group has producer-owned raw depth');

    const completeResources = dependencies({
      selectedShader: SHA_MEDIUM_SHADER,
      surfaceResources: true,
    });
    expect(() =>
      buildPerSubmeshMaterialBg(
        completeResources,
        mediumSnapshot(),
        4,
        undefined,
        SHA_MEDIUM_SHADER,
      ),
    ).not.toThrow();
    const entries = completeResources.bindGroupEntries[0] ?? [];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some(({ binding }) => binding === 47)).toBe(false);
  });
});
