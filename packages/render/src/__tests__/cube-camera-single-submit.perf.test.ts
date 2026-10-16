import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { createRenderer as constructRenderer } from '../assembly/factory';
import { createCubeCaptureScheduler } from '../capture/scheduler';
import { Camera } from '../components/camera';
import type { RenderTarget } from '../targets/contracts';

function manifestUrl(): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;
}

describe('CubeCamera single-submit benchmark contract', () => {
  it('measures actual Renderer receipts for the steady frame path', async () => {
    const renderer = await constructRenderer(
      { width: 1, height: 1, getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const spawned = world.spawn(
      { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
    );
    expect(spawned.ok).toBe(true);
    expect(world.update().ok).toBe(true);
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const initial = renderer.inspect().frame;
    const receipts = [];
    for (let index = 0; index < 6; index += 1) {
      const frame = renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      expect(frame.ok).toBe(true);
      if (!frame.ok || frame.value === undefined) return;
      receipts.push(frame.value);
      await frame.value.completed;
    }

    const inspected = renderer.inspect();
    expect(receipts).toHaveLength(6);
    expect(inspected.frame.frameId - initial.frameId).toBe(6);
    expect(inspected.perFramePassNames.length).toBeGreaterThan(0);
    expect(inspected.state).toBe('alive');
    await renderer.dispose();
  });

  it('retains neutral or previous active output after a failed submit', () => {
    const target = {} as RenderTarget;
    const scheduler = createCubeCaptureScheduler({ maxFacesPerFrame: 6 });
    expect(
      scheduler.request({
        target,
        position: [0, 0, 0],
        near: 0.1,
        far: 10,
        updateIntent: 'continuous',
        requestVersion: 1,
        faceBudget: 6,
      }).ok,
    ).toBe(true);
    scheduler.beginFrame();
    expect(scheduler.nextWork()).toHaveLength(6);
    expect(scheduler.completeSubmission(false).ok).toBe(false);
    expect(scheduler.inspect(target).activeGeneration).toBe(0);
    expect(scheduler.inspect(target).fallback).toBe('neutral');
  });
});
