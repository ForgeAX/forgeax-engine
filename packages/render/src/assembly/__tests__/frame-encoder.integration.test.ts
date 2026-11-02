import { World } from '@forgeax/engine-ecs';
import { RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import { ANTIALIAS_NONE, Camera } from '../../components/camera';
import { CameraView } from '../../components/camera-view';
import { CubeCamera } from '../../components/cube-camera';
import { createRenderer } from '../factory';

type Fixture = 'one-view' | 'three-views' | 'capture-only';
const FRAMES = 3;

/**
 * RenderRecord opens the submission's one command encoder: a Renderer frame
 * creates exactly one `render-frame` encoder however many views or captures
 * record into it. A second per-view or capture encoder fails this gate.
 */
it.each([
  'one-view',
  'three-views',
  'capture-only',
] as const)('creates one frame encoder per Renderer frame (%s)', async (fixture: Fixture) => {
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const created = vi.spyOn(RhiNullDevice.prototype, 'createCommandEncoder');
  try {
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    registerPropagateTransforms(world);
    const camera = { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_NONE };
    const views = fixture === 'three-views' ? 3 : 1;
    for (let order = 0; order < views; order++) {
      const entity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 4 + order] } },
          { component: Camera, data: camera },
        )
        .unwrap();
      // Capture-only: the one composed view is disabled, so the frame records only the CubeCamera.
      if (fixture !== 'one-view')
        world
          .addComponent(entity, {
            component: CameraView,
            data: {
              order,
              enabled: fixture === 'three-views',
              viewport: new Float32Array([order / 3, 0, 1 / 3, 1]),
            },
          })
          .unwrap();
    }
    if (fixture === 'capture-only') {
      const cube = renderer.createRenderTarget({
        shape: 'cube',
        width: 8,
        height: 8,
        format: 'rgba16float',
        mipLevels: 1,
        sampleCount: 1,
        sampled: true,
        readback: false,
      });
      if (!cube.ok) throw cube.error;
      world
        .spawn(
          { component: Transform, data: {} },
          {
            component: CubeCamera,
            data: { target: world.allocSharedRef('RenderTarget', cube.value) },
          },
        )
        .unwrap();
    }
    const input = {
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    };
    for (let frame = 0; frame < FRAMES; frame++) {
      expect(world.update().ok).toBe(true);
      created.mockClear();
      const result = renderer.draw(input);
      if (!result.ok) throw result.error;
      if (result.value === undefined) throw new Error('expected a submitted receipt');
      const labels = created.mock.calls.map(([descriptor]) => descriptor?.label ?? '');
      expect(labels.filter((label) => label === 'render-frame')).toHaveLength(1);
      // Per-pass helpers (mips, readbacks) may own their own buffers; no view does.
      expect(labels).not.toContain('render-system-frame');
      expect(labels.some((label) => /^(multi-camera|capture)-frame:/.test(label))).toBe(false);
      expect((await result.value.completed).ok).toBe(true);
    }
  } finally {
    created.mockRestore();
    await renderer.dispose();
  }
}, 60_000);
