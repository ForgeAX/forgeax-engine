import { World } from '@forgeax/engine-ecs';
import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import {
  buildPerSubmeshMaterialBg,
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

function mediumSnapshot() {
  return {
    ...defaultMaterialSnapshot(),
    materialShaderId: 'forgeax::selected-shadow',
    surfaceModel: 'single-layer-medium',
  } as never;
}

describe('main-pass Surface material selection', () => {
  it('keeps accepted bindings isolated across compound namespace boundaries', () => {
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
    buildPerSubmeshMaterialBg(deps, first as never, 4, scope('w:7'));
    buildPerSubmeshMaterialBg(deps, second as never, 4, scope('w'));
    const entries = [...deps.materialBgAssemblyCache.values()];
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
    Object.assign(deps.runtime, {
      getMaterialShaderArtifact: () => {
        events.push('artifact');
        return undefined;
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
    expect(buildPerSubmeshMaterialBg(deps, material as never, 4, world)).toBe(first);
    expect(events).toEqual(['resolve', 'handle', 'probe', 'scope', 'artifact', 'schema', 'layout']);
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
