import { World } from '@forgeax/engine-ecs';
import { createProfiler } from '@forgeax/engine-profiler';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import {
  ANTIALIAS_NONE,
  Camera as LocalCamera,
  TONEMAP_ACES_FILMIC,
} from '../../components/camera';
import { createRenderer } from '../factory';

describe('production frame CPU pass identities', () => {
  it('bridges the renderer-owned collector into a separately constructed render internals owner', async () => {
    const profiler = createProfiler();
    const renderer = await createRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi, profiler },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    try {
      expect((await renderer.initialization).ok).toBe(true);
      const world = new World();
      const attached = renderer.attach(world);
      if (!attached.ok) throw attached.error;
      const lease = attached.value;
      registerPropagateTransforms(world);
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 4] } },
          {
            component: LocalCamera,
            data: {
              fov: 1,
              aspect: 1,
              near: 0.1,
              far: 100,
              antialias: ANTIALIAS_NONE,
              tonemap: TONEMAP_ACES_FILMIC,
            },
          },
        )
        .unwrap();
      expect(world.update().ok).toBe(true);

      const frameInput = {
        source: lease,
      };
      const warmup = renderer.draw(frameInput);
      if (!warmup.ok) throw warmup.error;
      if (warmup.value === undefined) throw new Error('Warmup did not submit a frame');
      expect((await warmup.value.completed).ok).toBe(true);

      const started = profiler.startCapture({
        frameLimit: 1,
        eventLimit: 1024,
        detail: 'passes',
      });
      if (!started.ok) throw new Error(started.error.code);
      const session = started.value;
      const profileFrame = { captureId: session.captureId, frameId: 1 };
      expect(session.beginFrame(profileFrame.frameId).ok).toBe(true);

      const drawn = renderer.draw({ ...frameInput, profileFrame });
      if (!drawn.ok) throw drawn.error;
      if (drawn.value === undefined) throw new Error('Profiled draw did not submit a frame');
      expect(drawn.value.profileFrame).toEqual(profileFrame);
      expect((await drawn.value.completed).ok).toBe(true);

      expect(session.endFrame().ok).toBe(true);
      const capture = session.finish();
      if (!capture.ok) throw new Error(capture.error.code);

      const identities = drawn.value.renderPassCpuIdentities ?? [];
      expect(identities.length).toBeGreaterThan(0);
      expect(drawn.value.renderPassCpuIdentitiesComplete).toBe(true);
      expect(
        identities.some((identity) =>
          capture.value.records.some(
            (record) =>
              record.kind === 'phase' &&
              record.source === 'render' &&
              record.frameId === profileFrame.frameId &&
              record.phase === identity.phase,
          ),
        ),
      ).toBe(true);
    } finally {
      await renderer.dispose();
    }
  });
});
