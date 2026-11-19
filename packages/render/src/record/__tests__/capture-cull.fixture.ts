import { mat4 } from '@forgeax/engine-math';
import { assert, vi } from 'vitest';
import { MaterialResource } from '../../material-resource';
import type { CameraSnapshot } from '../../render-contract';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { FrameSet } from '../../scene/frame-set';
import { MaterialFrame } from '../../scene/material-dispatch';
import { MeshFrame } from '../../scene/mesh-frame';
import { ProbeBlendSceneProjection } from '../../scene/probe-blend';
import { RenderScene } from '../../scene/render-scene';
import { worldBounds, writeBounds } from '../../scene/render-scene-snapshots';
import type { SkinSceneFrame } from '../../scene/skin-scene-inputs';
import { CaptureCull } from '../capture-cull';
import { makeZeroCameraFallbackSnapshot } from '../frame-snapshot';

export function captureCullFixture() {
  const material = new MaterialResource({ ...defaultMaterialSnapshot(), immutableValues: true });
  const scene = new RenderScene();
  const unavailable = new FrameSet();
  const probe = new ProbeBlendSceneProjection().recordBufferProjection();
  const reads = vi.fn<(entity: number) => void>();
  const baseCamera = makeZeroCameraFallbackSnapshot();
  const f = {
    scene,
    material,
    materials: new MaterialFrame(undefined).with(material),
    meshes: new MeshFrame(),
    cull: new CaptureCull(),
    camera: baseCamera,
    reads,
    put(
      entityKey: number,
      x = 0,
      y = 0,
      z = -5,
      fields: Partial<RenderableSnapshot> = {},
    ): RenderableSnapshot {
      const world = mat4.identity(mat4.create());
      world[12] = x;
      world[13] = y;
      world[14] = z;
      scene.apply([
        {
          kind: 'update',
          entityKey,
          snapshot: {
            entityKey,
            material,
            materials: [material],
            materialBindingSources: ['engine-default'],
            assetHandle: 1,
            transform: { world },
            localAabb: new Float32Array([-0.3, -0.3, -0.01, 0.3, 0.3, 0.01]),
            ...fields,
          },
        },
      ]);
      return f.source(entityKey);
    },
    source(entityKey: number): RenderableSnapshot {
      const row = scene.slot(entityKey);
      assert(row);
      return row.snapshot;
    },
    prepare(
      camera: CameraSnapshot = baseCamera,
      skin?: SkinSceneFrame,
    ): NonNullable<ReturnType<CaptureCull['prepare']>> {
      const { meshes, materials } = f;
      const slots = scene.slotsSnapshot();
      const result = f.cull.prepare(
        camera,
        {
          draws: { slots, meshes, unavailable, probe, temporal: undefined },
          skin,
        },
        materials,
        (source, out, row) => {
          reads(source.entityKey);
          if (source.generatedMesh !== undefined || source.terrainSection !== undefined)
            return writeBounds(worldBounds(source), out);
          const record = row ?? slots.lookup(source.entityKey);
          return (
            record !== undefined &&
            scene.writeCullingWorldBoundsAt(record, out, meshes, materials, skin)
          );
        },
      );
      assert(result);
      return result;
    },
  };
  return f;
}
