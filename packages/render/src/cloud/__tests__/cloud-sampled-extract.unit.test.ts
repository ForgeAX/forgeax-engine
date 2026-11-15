import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetError, err, ok, type TextureAsset } from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';
import { DirectionalLight } from '../../components/directional-light';
import { VolumetricCloudLayer } from '../../components/volumetric-cloud-layer';
import type { RenderFeaturePlanContext } from '../../features/plan';
import { worldRenderResources } from '../../publication/resource-scope';
import { createSceneDataCatalog } from '../../temporal/scene-data-catalog';
import { createAnalyticCloudFeature } from '../analytic-feature';
import { cloudMaterialInstanceKind, cloudMaterialKind } from '../authoring/assets';
import { cloudIdentity } from '../authoring/identity';
import {
  CLOUD_REFERENCE_TEXTURE_ROLES,
  type CloudMaterialAsset,
  type CloudMaterialInstanceAsset,
  type CloudParameter,
} from '../contracts';
import { extractStandardCloudLayer } from '../extract';
import { prepareCloudShadowView } from '../lighting/shadow-view';
import { captureCloudAdoption } from '../reconstruction/adoption';

afterEach(() => vi.restoreAllMocks());

const textureGuid = (index: number) => `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

function fixture(
  overrides: CloudMaterialInstanceAsset['overrides'] = {},
  component: Record<string, number> = {},
  instanceChanges: Partial<CloudMaterialInstanceAsset> = {},
  onlyDetailOff = false,
  reverseParameters = false,
) {
  const assets = new AssetRegistry();
  // Extraction consumes prepared assets; decoder validation has its own tests.
  assets.installDecoder(cloudMaterialKind, {
    decode: async ({ envelope }) => ok(envelope.payload as CloudMaterialAsset),
    prepare: (value) => ok(value),
  });
  assets.installDecoder(cloudMaterialInstanceKind, {
    decode: async ({ envelope }) => ok(envelope.payload as CloudMaterialInstanceAsset),
    prepare: (value) => ok(value),
  });
  const authoredParameters: Record<string, CloudParameter> = {
    useDetail: { kind: 'static', default: false },
    albedo: { kind: 'vector', default: [1, 1, 1, 1] },
    ...Object.fromEntries(
      Object.entries({
        layoutScaleMeters: 1000,
        coverageBias: 0,
        extinctionPerMeter: 0.002,
        layoutWeight: 1,
        maskWeight: 1,
        profileWeight: 1,
        bodyWeight: 1,
        erosionWeight: 1,
      }).map(([name, value]) => [name, { kind: 'scalar', unit: 'unitless', default: value }]),
    ),
    ...Object.fromEntries(
      CLOUD_REFERENCE_TEXTURE_ROLES.map(([role, dimension], index) => [
        role,
        {
          kind: 'texture',
          dimension,
          default: textureGuid(index),
          colorSpace: 'linear',
          mipLevels: 1,
        },
      ]),
    ),
  };
  const parameters = reverseParameters
    ? Object.fromEntries(Object.entries(authoredParameters).reverse())
    : authoredParameters;
  const material: CloudMaterialAsset = {
    kind: 'cloud-material',
    version: 1,
    model: 'program',
    cookIdentity: 'sampled-cook',
    densityKernelIdentity: 'a'.repeat(64),
    parameters,
    variants: (onlyDetailOff ? [false] : [false, true]).map((useDetail) => ({
      staticValues: { useDetail },
      programIdentity: `detail-${useDetail}`,
      artifact: 'fixture',
      compilerIdentity: 'fixture',
      programDigest: 'fixture',
      bindings: [],
    })),
  };
  const materialHandle = assets.create(cloudMaterialKind, material).unwrap();
  const instance = assets
    .create(cloudMaterialInstanceKind, {
      kind: 'cloud-material-instance',
      version: 1,
      material: 'material-guid',
      parameterIdentity: cloudIdentity(parameters),
      overrides,
      ...instanceChanges,
    } satisfies CloudMaterialInstanceAsset)
    .unwrap();
  const world = new World({ assets });
  world
    .spawn({ component: DirectionalLight, data: { direction: new Float32Array([0, -1, 0]) } })
    .unwrap();
  world
    .spawn({
      component: VolumetricCloudLayer,
      data: { material: materialHandle, materialInstance: instance as never, ...component },
    })
    .unwrap();
  const scope = worldRenderResources(world);
  vi.spyOn(scope, 'sourceForAsset').mockImplementation((handle) =>
    handle === materialHandle ? { guid: 'material-guid' } : { guid: 'instance-guid' },
  );
  const textures = new Map(
    [...CLOUD_REFERENCE_TEXTURE_ROLES, ['replacement', '2d'] as const].map(
      ([_role, dimension], index) => {
        const texture: TextureAsset = {
          kind: 'texture',
          shape:
            dimension === '3d'
              ? { viewDimension: '3d', extent: { width: 1, height: 1, depth: 1 } }
              : { viewDimension: '2d', extent: { width: 1, height: 1 } },
          format: 'rgba8unorm',
          colorSpace: 'linear',
          mips: { kind: 'none' },
          data: new Uint8Array(4),
        };
        return [textureGuid(index), assets.create(texture).unwrap()] as const;
      },
    ),
  );
  vi.spyOn(scope, 'handleForGuid').mockImplementation((guid) => textures.get(guid));
  return { assets, scope, instance, extract: () => extractStandardCloudLayer(world) };
}

it('extracts instance scalar, vector, texture and static values from the selected publication', () => {
  const f = fixture({
    layoutScaleMeters: 2500,
    coverageBias: 0.25,
    extinctionPerMeter: 0.004,
    layoutWeight: 0.25,
    albedo: [0.2, 0.3, 0.4, 1],
    layoutPattern: textureGuid(4),
    useDetail: true,
  });
  try {
    const layer = f.extract().unwrap();
    expect(layer).toMatchObject({
      status: 'sampled',
      layoutScaleMeters: 2500,
      coverageBias: 0.25,
      extinctionPerMeter: 0.004,
      weights: [0.25, 1, 1, 1, 1],
      albedo: [0.2, 0.3, 0.4, 1],
      useDetail: true,
      programIdentity: 'detail-true',
      textures: expect.arrayContaining([
        expect.objectContaining({ role: 'layoutPattern', guid: textureGuid(4), revision: 7 }),
      ]),
    });
  } finally {
    f.assets.dispose();
  }
});

it('applies component overrides before resolving the selected static variant', () => {
  const f = fixture(
    { useDetail: true, coverageBias: 0.2, extinctionPerMeter: 0.004, layoutWeight: 0.25 },
    {
      requestRevision: 7,
      useDetail: 0,
      coverageBias: 0.5,
      extinctionOverridePerMeter: 0.01,
      layoutWeight: 0.75,
      viewSampleCountScale: 2,
      shadowMode: 1,
    },
    {},
    true,
  );
  try {
    const layer = f.extract().unwrap();
    if (layer?.status !== 'sampled') throw new Error('Expected sampled cloud');
    expect(layer).toMatchObject({
      status: 'sampled',
      useDetail: false,
      programIdentity: 'detail-false',
      coverageBias: 0.5,
      extinctionPerMeter: expect.closeTo(0.01),
      weights: [0.75, 1, 1, 1, 1],
    });
    expect(layer.shadowMap).toBeUndefined();
    expect(layer.shadowSettings?.mode).toBe(1);
    const prepared = prepareCloudShadowView(layer, [0, 0, 0]);
    if (prepared === undefined) throw new Error('Expected prepared cloud');
    expect(captureCloudAdoption(prepared, undefined, true)).toMatchObject({
      requestRevision: 7,
      materialGuid: 'material-guid',
      instanceGuid: 'instance-guid',
      programIdentity: 'detail-false',
      values: {
        useDetail: false,
        extinctionPerMeter: Math.fround(0.01),
        coverageBias: 0.5,
        layoutWeight: 0.75,
        viewSampleCountMax: 192,
        shadowMode: 1,
        shadowMapSamples: 64,
      },
      unavailableFields: { shadowSamples: 'inactive', atmosphereTransmittanceMode: 'inactive' },
    });
  } finally {
    f.assets.dispose();
  }
});

it('publishes texture roles in canonical binding order even when authored parameters are reversed', () => {
  const f = fixture({ layoutPattern: textureGuid(4) }, {}, {}, false, true);
  try {
    const layer = f.extract().unwrap();
    if (layer?.status !== 'sampled') throw new Error('Expected sampled cloud');
    expect(layer.textures.map(({ role, dimension }) => [role, dimension])).toEqual(
      CLOUD_REFERENCE_TEXTURE_ROLES,
    );
    expect(layer.textures[0]?.guid).toBe(textureGuid(4));
    const feature = createAnalyticCloudFeature();
    const context: RenderFeaturePlanContext = {
      caps: { rgba16floatRenderable: true, backendKind: 'webgpu' } as never,
      frame: { frameNumber: 1 },
      generation: 1,
      getFeatureShaderSource: () => '// CPU plan fixture',
      views: [
        {
          identity: 'camera',
          render: true,
          frame: { frameNumber: 1 },
          targets: [
            { name: 'motion-output', kind: 'color', format: 'rgba16float', sampleCount: 1 },
            { name: 'depth', kind: 'depth', format: 'depth32float-stencil8', sampleCount: 1 },
          ],
          sceneData: createSceneDataCatalog({
            featureIdentity: feature.identity,
            generation: 1,
            planIdentity: 'camera',
            rgba16floatRenderable: true,
          }),
        },
      ],
    };
    const prepared = prepareCloudShadowView(layer, [0, 0, 0]);
    if (prepared === undefined) throw new Error('Expected prepared cloud');
    const plan = feature.plan({ camera: prepared }, context).unwrap();
    for (const name of ['cloud-bsm-inputs', 'analytic-cloud-inputs']) {
      const bindings = plan.work
        ?.flatMap((work) => work.resources ?? [])
        .find((resource) => resource.name === name);
      expect(bindings).toMatchObject({
        kind: 'graphics-bindings',
        values: {
          assetTextures: layer.textures.map(({ handle, guid, revision, dimension }) => ({
            handle,
            guid,
            revision,
            dimension,
          })),
        },
      });
    }
  } finally {
    f.assets.dispose();
  }
});

it.each([
  { material: 'other-material' },
  { parameterIdentity: 'other-interface' },
])('rejects an instance with a different parent identity: %j', (changes) => {
  const f = fixture({}, {}, changes);
  try {
    expect(f.extract().ok).toBe(false);
  } finally {
    f.assets.dispose();
  }
});

it('rejects an unresolved instance texture instead of falling back to its material default', () => {
  const f = fixture({ layoutPattern: textureGuid(99) });
  try {
    expect(f.extract().ok).toBe(false);
  } finally {
    f.assets.dispose();
  }
});

it('rejects an instance whose selected static variant is absent', () => {
  const f = fixture({ useDetail: true }, {}, {}, true);
  try {
    expect(f.extract().ok).toBe(false);
  } finally {
    f.assets.dispose();
  }
});

it('fails closed when the bound instance has not finished loading', () => {
  const f = fixture();
  const read = f.assets.read.bind(f.assets);
  vi.spyOn(f.assets, 'read').mockImplementation((handle) =>
    handle === f.instance
      ? err(
          new AssetError({
            code: 'asset-not-ready',
            expected: 'a prepared instance',
            hint: 'wait for the fixture publication',
          }),
        )
      : read(handle),
  );
  try {
    expect(f.extract()).toMatchObject({
      ok: false,
      error: { detail: { field: 'materialInstance' } },
    });
  } finally {
    f.assets.dispose();
  }
});

it('fails closed when the selected texture publication has no ready revision', () => {
  const f = fixture({ layoutPattern: textureGuid(4) });
  const revision = f.scope.assetRevision.bind(f.scope);
  const selected = f.scope.handleForGuid(textureGuid(4));
  vi.spyOn(f.scope, 'assetRevision').mockImplementation((handle) =>
    handle === selected ? undefined : revision(handle),
  );
  try {
    expect(f.extract()).toMatchObject({
      ok: false,
      error: { detail: { field: 'layoutPattern' } },
    });
  } finally {
    f.assets.dispose();
  }
});
