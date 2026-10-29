import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import type { AssetHandle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { ShadowParticipation } from '../components/shadow-participation';
import { Materials } from '../materials';
import { meshSurfaceFlags } from '../record/mesh-ssbo';
import { extractFrames } from '../render-system-extract-tail';
import { RENDERABLE_SOURCE_COMPONENTS } from '../scene/render-source';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

function cube(
  world: World,
  assets: AssetRegistry,
  participation?: { cast: boolean; receive: boolean },
  materials?: readonly AssetHandle<'material'>[],
): void {
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: assets.create(BUILTIN_CUBE).unwrap() } },
      { component: MeshRenderer, data: materials === undefined ? {} : { materials } },
      ...(participation === undefined
        ? []
        : [{ component: ShadowParticipation, data: participation }]),
    )
    .unwrap();
}

describe('ShadowParticipation extraction', () => {
  it('strips shadow-caster dispatch only for cast-disabled entities', () => {
    const assets = new AssetRegistry({ shaderRegistry: {} as never });
    const world = new World({ assets });
    cube(world, assets);
    cube(world, assets, { cast: false, receive: true });
    cube(world, assets, { cast: true, receive: false });
    const frame = extractFrames([world], 0, assets);
    const casters = (renderableIndex: number) =>
      frame.dispatch.filter(
        (entry) =>
          entry.renderableIndex === renderableIndex && entry.tags.LightMode === 'ShadowCaster',
      ).length;
    const colors = (renderableIndex: number) =>
      frame.dispatch.filter(
        (entry) =>
          entry.renderableIndex === renderableIndex && entry.tags.LightMode !== 'ShadowCaster',
      ).length;
    expect(frame.renderables).toHaveLength(3);
    expect(casters(0)).toBeGreaterThan(0);
    expect(casters(1)).toBe(0);
    expect(casters(2)).toBe(casters(0));
    for (const index of [0, 1, 2]) expect(colors(index)).toBe(colors(0));
    expect(colors(0)).toBeGreaterThan(0);
  });

  it('drops shadow casting for blended-only meshes unless participation is authored', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const material = (blend?: 'alpha' | 'additive') =>
      assets
        .create(
          Materials.unlit([0.4, 0.8, 1, 0.5], {
            ...(blend === undefined
              ? {}
              : {
                  renderState: {
                    depthWriteEnabled: false,
                    blend:
                      blend === 'additive'
                        ? {
                            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                          }
                        : {
                            color: {
                              srcFactor: 'src-alpha',
                              dstFactor: 'one-minus-src-alpha',
                              operation: 'add',
                            },
                            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                          },
                  },
                }),
          }),
        )
        .unwrap();
    const opaque = material();
    const alpha = material('alpha');
    const additive = material('additive');
    cube(world, assets, undefined, [opaque]);
    cube(world, assets, undefined, [alpha]);
    cube(world, assets, undefined, [additive]);
    cube(world, assets, { cast: true, receive: true }, [additive]);
    cube(world, assets, undefined, [opaque, alpha]);
    const frame = extractFrames([world], 0, assets);
    const casters = frame.renderables.map(
      (_renderable, renderableIndex) =>
        frame.dispatch.filter(
          (entry) =>
            entry.renderableIndex === renderableIndex && entry.tags.LightMode === 'ShadowCaster',
        ).length > 0,
    );
    expect(casters).toEqual([true, false, false, true, true]);
    expect(frame.renderables.map((renderable) => renderable.shadowCaster)).toEqual([
      undefined,
      false,
      false,
      undefined,
      undefined,
    ]);
  });

  it('marks receive-disabled renderables without touching the others', () => {
    const assets = new AssetRegistry({ shaderRegistry: {} as never });
    const world = new World({ assets });
    cube(world, assets);
    cube(world, assets, { cast: false, receive: true });
    cube(world, assets, { cast: true, receive: false });
    const frame = extractFrames([world], 0, assets);
    expect(frame.renderables.map((renderable) => renderable.shadowReceiver)).toEqual([
      undefined,
      undefined,
      false,
    ]);
  });

  it('re-projects a renderable when its participation changes', () => {
    expect(RENDERABLE_SOURCE_COMPONENTS).toContain(ShadowParticipation);
  });

  it('packs motion validity and shadow reception into distinct Mesh flag bits', () => {
    expect(meshSurfaceFlags({})).toBe(1);
    expect(meshSurfaceFlags({ temporal: { motionValid: false } })).toBe(0);
    expect(meshSurfaceFlags({ shadowReceiver: false })).toBe(3);
    expect(meshSurfaceFlags({ temporal: { motionValid: false }, shadowReceiver: false })).toBe(2);
  });
});
