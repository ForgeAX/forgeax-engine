import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { createRenderer } from '../assembly/factory';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  Camera,
} from '../components/camera';
import { DeviceScope } from '../device/device-scope';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

function expectDetached(value: unknown, seen = new Set<unknown>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(value).not.toBeInstanceOf(Error);
  expect(value).not.toBeInstanceOf(Map);
  expect(value).not.toBeInstanceOf(Set);
  expect(ArrayBuffer.isView(value)).toBe(false);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new Error('detached inspection contains a live class instance');
  }
  for (const child of Object.values(value)) expectDetached(child, seen);
}

describe('detached renderer inspection', () => {
  it('exposes JSON-safe exact-zero cold state', async () => {
    const renderer = await createRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      {
        shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`,
      },
    );
    const inspection = renderer.inspect();
    expect(inspection.environment.status).toBe('empty');
    expect(inspection.temporal.mode).toBe('none');
    expect(inspection.bloom).toMatchObject({
      graphStatus: 'empty',
      enabled: false,
      targetCount: 0,
      resourceCount: 0,
      passCount: 0,
      encodeCount: 0,
      bindGroupCount: 0,
      uploadCount: 0,
      residentChildBytes: 0,
    });
    expect(() => JSON.parse(JSON.stringify(inspection))).not.toThrow();
    expectDetached(inspection);
    expect(Object.isFrozen(inspection.environment)).toBe(true);
    expect(Object.isFrozen(inspection.temporal.coverage)).toBe(true);
    expect(() => expectDetached(DeviceScope.create(401, 'live-scope'))).toThrow(
      'live class instance',
    );
    expect((await renderer.dispose()).ok).toBe(true);
  });

  it('projects a successful TAA frame into detached PODs', async () => {
    const renderer = await createRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_TAA },
        },
      )
      .unwrap();
    expect(world.update().ok).toBe(true);
    const frameInput = () => ({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    let frame = renderer.draw(frameInput());
    if (!frame.ok) {
      await Promise.resolve();
      frame = renderer.draw(frameInput());
    }
    expect(frame.ok).toBe(true);
    const inspection = renderer.inspect();
    expect(inspection.environment.status).toBe('active');
    expect(inspection.environment.activeSignature).toBeDefined();
    expect(inspection.temporal.mode).toBe('taa');
    expect(inspection.ssr).toMatchObject({
      status: 'not-requested',
      history: { state: 'not-owned', bytes: 0, resetCount: 0 },
      passRoster: [],
    });
    expect(inspection.temporal.resources.active).toBeGreaterThan(0);
    expect(inspection.temporal.resources.candidate).toBe(0);
    expect(inspection.lodOcclusion).toMatchObject({
      schema: 'forgeax::lod-occlusion-inspection::v3',
      view: { viewRole: 'main', cameraEntity: camera },
      count: { candidates: 0, visible: 0, occluded: 0 },
    });
    expect(inspection.temporalTarget).toMatchObject({
      identity: 'standard-scene-temporal',
      producerId: 'forgeax::standard::scene-data',
      schema: 'forgeax::scene-data::temporal-v1',
      targetCount: 1,
      descriptor: {
        format: 'rgba16float',
        width: 64,
        height: 64,
        sampleCount: 1,
        bytes: 64 * 64 * 8,
      },
    });
    const serialized = JSON.parse(JSON.stringify(inspection));
    expect(serialized.temporal.viewIdentity).toBe(inspection.temporal.viewIdentity);
    expectDetached(inspection);
    const originalWidth = inspection.temporal.coverage.width;
    try {
      (inspection.temporal.coverage as { width: number }).width = originalWidth + 1;
    } catch {
      // Frozen detached snapshots reject mutation in strict callers.
    }
    expect(renderer.inspect().temporal.coverage.width).toBe(originalWidth);
    const nestedBefore = renderer.inspect();
    for (const subtree of [
      nestedBefore.environment.active,
      nestedBefore.environment.lkg,
      nestedBefore.environment.lastCandidateFailure?.detail,
      nestedBefore.temporal.resources,
      nestedBefore.temporal.coverage,
      nestedBefore.bloom,
    ]) {
      if (subtree !== undefined) expect(Object.isFrozen(subtree)).toBe(true);
    }
    const detachedBefore = JSON.parse(JSON.stringify(nestedBefore));
    for (const subtree of [
      nestedBefore.environment.active,
      nestedBefore.environment.lkg,
      nestedBefore.environment.lastCandidateFailure?.detail,
      nestedBefore.temporal,
      nestedBefore.temporal.resources,
      nestedBefore.temporal.coverage,
      nestedBefore.bloom,
    ]) {
      if (subtree === undefined) continue;
      try {
        (subtree as Record<string, unknown>).generation = -1;
        (subtree as Record<string, unknown>).detail = { injected: true };
      } catch {
        // Frozen snapshots reject mutation; callers still get detached values.
      }
    }
    expect(JSON.parse(JSON.stringify(renderer.inspect()))).toEqual(detachedBefore);
    world.set(camera, Camera, { antialias: ANTIALIAS_NONE }).unwrap();
    expect(world.update().ok).toBe(true);
    expect(renderer.draw(frameInput()).ok).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(renderer.inspect().temporal.mode).toBe('none');
    for (const antialias of [ANTIALIAS_FXAA, ANTIALIAS_MSAA]) {
      world.set(camera, Camera, { antialias }).unwrap();
      expect(world.update().ok).toBe(true);
      expect(renderer.draw(frameInput()).ok).toBe(true);
      expect(renderer.inspect().temporal.mode).toBe(antialias === ANTIALIAS_FXAA ? 'fxaa' : 'msaa');
      expect(renderer.inspect().temporal.resources).toEqual({
        active: 0,
        candidate: 0,
        retiring: 0,
        activeBytes: 0,
        candidateBytes: 0,
        retiringBytes: 0,
      });
    }
    await renderer.dispose();
  });
});
