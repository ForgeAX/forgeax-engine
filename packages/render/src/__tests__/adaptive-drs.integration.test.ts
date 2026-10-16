import { World } from '@forgeax/engine-ecs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { ANTIALIAS_TAA, Camera } from '../components/camera';
import { DynamicResolution } from '../components/dynamic-resolution';
import { GpuTimingCapture } from '../record/gpu-timing';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it('reports unsupported DRS, allocates no queries, and restores native TAA on removal', async () => {
  const createTiming = vi.spyOn(GpuTimingCapture, 'create');
  let failSubmit = false;
  const renderer = await createRenderer(
    { width: 128, height: 128, getContext: () => null },
    {
      rhi,
      rhiInstrumentation: {
        beforeSubmit: () =>
          failSubmit
            ? new RhiError({
                code: 'rhi-not-available',
                expected: 'successful DRS candidate submission',
                hint: 'clear the test submit failure and retry',
              })
            : undefined,
      },
    },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  expect((await renderer.initialization).ok).toBe(true);
  const world = new World();
  const attachment = renderer.attach(world);
  if (!attachment.ok) throw attachment.error;
  const attached = attachment.value;
  registerPropagateTransforms(world);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      { component: Camera, data: { antialias: ANTIALIAS_TAA } },
      { component: DynamicResolution, data: { minScale: 0.5, maxScale: 0.75 } },
    )
    .unwrap();
  const draw = () => {
    world.update(1 / 60).unwrap();
    return renderer.draw({
      leases: [attached],
      camera: { lease: attached },
      environment: { lease: attached },
    });
  };
  try {
    for (let frame = 0; frame < 60; frame++) expect(draw().ok).toBe(true);
    expect(renderer.inspect().dynamicResolution).toMatchObject({
      status: 'unavailable',
      gpuMs: undefined,
      extent: { outputWidth: 128, internalWidth: 96, scale: 0.75 },
    });
    expect(createTiming).not.toHaveBeenCalled();
    if (renderer.requestObservation === undefined)
      throw new Error('missing observation capability');
    const requested = renderer.requestObservation(['final-display']);
    if (!requested.ok) throw requested.error;
    expect(draw().ok).toBe(true);
    expect(renderer.inspect().perFramePassNames).toContain('final-display-observation');
    const accepted = renderer.inspect().dynamicResolution?.extent;
    world.set(camera, DynamicResolution, { minScale: 0.5, maxScale: 0.5 }).unwrap();
    failSubmit = true;
    expect(draw().ok).toBe(false);
    expect(renderer.inspect().dynamicResolution?.extent).toEqual(accepted);
    failSubmit = false;
    expect(draw().ok).toBe(true);
    expect(renderer.inspect().dynamicResolution?.extent?.internalWidth).toBe(64);

    const compile = vi.spyOn(RenderGraphBuilder.prototype, 'compile').mockReturnValue(
      err(
        Object.assign(new Error('forced DRS removal compile rejection'), {
          code: 'graph-compile-failed',
        }),
      ) as never,
    );
    world.removeComponent(camera, DynamicResolution).unwrap();
    try {
      // A retained reduced graph cannot be submitted as a native frame, even
      // if rebuilding fails repeatedly after the component has disappeared.
      expect(draw().ok).toBe(false);
      expect(draw().ok).toBe(false);
    } finally {
      compile.mockRestore();
    }
    expect(draw().ok).toBe(true);
    expect(renderer.inspect().dynamicResolution).toBeUndefined();
    expect(renderer.inspect().temporalTarget?.descriptor).toMatchObject({
      width: 128,
      height: 128,
    });
    expect(renderer.inspect().perFramePassNames).not.toContain('standard-scene-coverage');
  } finally {
    attached.dispose();
    await renderer.dispose();
    createTiming.mockRestore();
  }
});
