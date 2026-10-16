import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { ShadowParticipation } from '../components/shadow-participation';
import { meshSurfaceFlags } from '../record/mesh-ssbo';
import { extractFrames } from '../render-system-extract-tail';
import { RENDERABLE_SOURCE_COMPONENTS } from '../scene/render-source';

function cube(world: World, participation?: { cast: boolean; receive: boolean }): void {
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      ...(participation === undefined
        ? []
        : [{ component: ShadowParticipation, data: participation }]),
    )
    .unwrap();
}

describe('ShadowParticipation extraction', () => {
  it('strips shadow-caster dispatch only for cast-disabled entities', () => {
    const world = new World();
    cube(world);
    cube(world, { cast: false, receive: true });
    cube(world, { cast: true, receive: false });
    const frame = extractFrames([world], 0, new AssetRegistry({} as never));
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

  it('marks receive-disabled renderables without touching the others', () => {
    const world = new World();
    cube(world);
    cube(world, { cast: false, receive: true });
    cube(world, { cast: true, receive: false });
    const frame = extractFrames([world], 0, new AssetRegistry({} as never));
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
