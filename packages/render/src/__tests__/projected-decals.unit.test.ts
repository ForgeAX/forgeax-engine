import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { Visibility } from '../components/visibility';
import { ProjectedDecal } from '../decals/component';
import { extractProjectedDecals } from '../decals/extract';
import { projectedDecalTopology } from '../decals/graph';
import { Materials } from '../materials';
import { publicationFrameDependencies } from '../publication/dependencies';
import { prepareExtractContext } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';

function setup() {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const handle = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 0, 0, 1] }),
  );
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: ProjectedDecal, data: { material: handle } },
    )
    .unwrap();
  const extract = () => {
    propagateTransforms(world).unwrap();
    return extractProjectedDecals(world, prepareExtractContext(world, { assets }));
  };
  return { world, entity, extract, handle };
}

describe('projected decal source contract', () => {
  it('detaches mutable transforms and preserves shape identity across numeric edits', () => {
    const { world, entity, extract } = setup();
    const before = extract();
    expect(before).toHaveLength(1);
    world.set(entity, Transform, { pos: [3, 2, 1] }).unwrap();
    world.set(entity, ProjectedDecal, { opacity: 0.3, order: 5 }).unwrap();
    const after = extract();
    expect(after[0]?.transform[12]).toBe(3);
    expect(before[0]?.transform[12]).toBe(0);
    expect(projectedDecalTopology(after)).toEqual(projectedDecalTopology(before));
  });
  it('omits invisible or zero-weight work and sorts overlap deterministically', () => {
    const { world, entity, extract, handle } = setup();
    const second = world
      .spawn(
        { component: Transform, data: {} },
        { component: ProjectedDecal, data: { material: handle, order: -1 } },
      )
      .unwrap();
    expect(extract().map((d) => d.entityKey)).toEqual([second, entity]);
    world.set(entity, ProjectedDecal, { opacity: 0 }).unwrap();
    expect(extract()).toHaveLength(1);
    world.addComponent(second, { component: Visibility, data: { state: 1 } }).unwrap();
    expect(extract()).toHaveLength(0);
  });
  it('rejects singular boxes, unsupported material maps and invalid weights', () => {
    const { world, entity, extract } = setup();
    world.set(entity, Transform, { scale: [0, 1, 1] }).unwrap();
    expect(extract).toThrow(/projection box/);
    world.set(entity, Transform, { scale: [1e-39, 1, 1] }).unwrap();
    expect(extract).toThrow(/float32 inverse/);
    world.set(entity, Transform, { scale: [1, 1, 1] }).unwrap();
    world.set(entity, ProjectedDecal, { opacity: 2 }).unwrap();
    expect(extract).toThrow(/opacity/);
    const unsupported = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [1, 1, 1, 1], metallicTexture: 111 }),
    );
    world.set(entity, ProjectedDecal, { opacity: 1, material: unsupported }).unwrap();
    expect(extract).toThrow(/metallicTexture/);
  });
  it('publishes the complete texture and sampler closure for a decal-only World', () => {
    const { world, entity, extract } = setup();
    const color = world.allocSharedRef('TextureAsset', {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array([255, 255, 255, 255]),
    });
    const sampler = world.allocSharedRef('SamplerAsset', {
      kind: 'sampler',
      magFilter: 'nearest',
      minFilter: 'nearest',
    });
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        baseColorTexture: { texture: color, sampler },
      }),
    );
    world.set(entity, ProjectedDecal, { material }).unwrap();
    const decals = extract();
    const frame = extractFrames(
      [world],
      0,
      new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined })),
    );
    expect(decals[0]?.samplers[0]?.magFilter).toBe('nearest');
    expect(publicationFrameDependencies(frame)).toEqual(
      expect.arrayContaining([material, color, sampler]),
    );
    expect(projectedDecalTopology(decals)[0]?.[0]).toMatchObject({
      format: 'rgba8unorm',
      size: { width: 1, height: 1 },
    });
    expect(() =>
      projectedDecalTopology(
        Array.from({ length: 65 }, () => decals[0] as NonNullable<(typeof decals)[0]>),
      ),
    ).toThrow(/64/);
  });
});
