import { MemoryError } from '@forgeax/engine-ecs';
import { MeshFilter } from '@forgeax/engine-render';
import { MorphWeights } from '@forgeax/engine-scene';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { pickTriangle } from '../pick-triangle';
import { pickVertexOnEntity } from '../pick-vertex';
import { skinScene } from './skin-scene.fixture';

it('reuses deformation scratch while returned hits and source geometry stay independent', () => {
  const s = skinScene(1024);
  const source = new Float32Array(s.mesh.attributes.position as Float32Array);
  const delta = new Float32Array(source.length).fill(0.01);
  const mesh = { ...s.mesh, morphTargets: [{ position: delta }] };
  s.world.set(s.entity, MeshFilter, { assetHandle: s.assets.create(mesh).unwrap() }).unwrap();
  s.world.addComponent(s.entity, { component: MorphWeights, data: { weights: [0.1] } }).unwrap();
  const hit = pickTriangle(s.world, s.camera, 64, 64, 128, 128);
  const vertex = pickVertexOnEntity(s.world, s.camera, 64, 64, 128, 128, s.entity);
  expect(hit.status).toBe('hit');
  expect(vertex).toBeDefined();
  const kept = JSON.stringify({ hit, vertex });
  const warmed = s.world.memoryStats().arena;
  expect(warmed.peakBytes).toBeGreaterThan(source.byteLength);
  for (let i = 0; i < 8; i++) {
    s.world
      .withFrameArena(() => {
        // Force nonzero offsets and poison every lane a subsequent query may reuse.
        s.world.frameArena.alloc(Float64Array, 64).unwrap().fill(Number.NaN);
        expect(pickTriangle(s.world, s.camera, 64, 64, 128, 128).status).toBe('hit');
        return ok(undefined);
      })
      .unwrap();
    s.pose(i * 0.001, i * 0.001);
    expect(pickTriangle(s.world, s.camera, 64, 64, 128, 128).status).toBe('hit');
  }
  expect(JSON.stringify({ hit, vertex })).toBe(kept);
  expect(s.mesh.attributes.position).toEqual(source);
  expect(s.world.frameArena.isActive).toBe(false);
  expect(s.world.memoryStats().arena.backingAllocations).toBe(warmed.backingAllocations);
});

it('closes a failed deformation scope and permits a fresh query after admission recovers', () => {
  const s = skinScene(128);
  const error = new MemoryError({ kind: 'budget', requestedBytes: 1024, limitBytes: 0 });
  const admission = vi.spyOn(s.world.frameArena, 'alloc').mockReturnValueOnce(err(error));
  expect(() => pickTriangle(s.world, s.camera, 64, 64, 128, 128)).toThrow(error);
  expect(s.world.frameArena.isActive).toBe(false);
  admission.mockRestore();
  expect(pickTriangle(s.world, s.camera, 64, 64, 128, 128).status).toBe('hit');
});
