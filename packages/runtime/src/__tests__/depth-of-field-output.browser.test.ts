import {
  ANTIALIAS_TAA,
  ANTIALIAS_TSR,
  DEFAULT_STANDARD_PROFILE,
  DepthOfField,
  DepthOfFieldSideValue,
} from '@forgeax/engine-render';
import { rhi as webgl } from '@forgeax/engine-rhi-wgpu';
import { registerPropagateTransforms } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { createDepthOfFieldScene } from './depth-of-field-scene.fixture';

it.each([
  { backend: 'webgpu', renderPath: 'deferred', antialias: ANTIALIAS_TSR },
  { backend: 'webgpu', renderPath: 'forward', antialias: ANTIALIAS_TAA },
  { backend: 'wgpu-webgl2', renderPath: 'forward', antialias: ANTIALIAS_TAA },
] as const)('renders pre-temporal depth of field on $backend $renderPath', async ({
  backend,
  renderPath,
  antialias,
}) => {
  const canvas = document.createElement('canvas');
  canvas.width = 129;
  canvas.height = 73;
  document.body.append(canvas);
  const compilation =
    backend === 'webgpu' ? vi.spyOn(GPUDevice.prototype, 'createShaderModule') : undefined;
  const countDepthOfField = () =>
    compilation?.mock.calls.filter(([descriptor]) => descriptor.code.includes('fn fs_coc(')).length;
  const countTaa = () =>
    compilation?.mock.calls.filter(([descriptor]) => descriptor.code.includes('fn fs_taa_resolve('))
      .length;
  const host = await constructRuntimeRendererHost(
    canvas,
    {
      ...(backend === 'wgpu-webgl2' ? { rhi: webgl } : {}),
      standardProfile: {
        ...DEFAULT_STANDARD_PROFILE,
        renderPath,
        ambientOcclusion: { enabled: false },
      },
    },
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!host.ok) {
    compilation?.mockRestore();
    throw host.error;
  }
  const { renderer } = host.value;
  const { world, camera } = createDepthOfFieldScene(canvas.width, canvas.height, antialias, 0.5);
  const releaseTransforms = registerPropagateTransforms(world);
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    const initialized = await host.value.initialization;
    if (!initialized.ok) throw initialized.error;
    if (compilation !== undefined) {
      expect(countDepthOfField()).toBe(0);
      expect(countTaa()).toBe(0);
      const labels = compilation.mock.calls.map(([descriptor]) => descriptor.label);
      expect(labels).not.toContain('ssr_trace');
      expect(labels).not.toContain('ssr_compose');
      expect(labels).not.toContain('scene-velocity-temporal');
      expect(labels).not.toContain('motion-blur-tile-summary');
      expect(labels).not.toContain('shadow-static-depth-clear');
    }
    const lease = renderer.attach(world).unwrap();
    try {
      const read = async () => {
        world.update(1 / 60).unwrap();
        const receipt = await drawReadyFrame(renderer, { source: lease }, ['final-display']);
        const capture = await renderer.observe(receipt, { include: ['final-display'] });
        if (!capture.ok) throw capture.error;
        const image = capture.value.observations?.find((entry) => entry.domain === 'final-display');
        if (image === undefined) throw new Error('missing final display readback');
        const { bytesPerRow, format } = image.metadata;
        const redChannel = format.startsWith('bgra') ? 2 : 0;
        return {
          outside: image.bytes[36 * bytesPerRow + 80 * 4 + redChannel] ?? 0,
          inside: image.bytes[36 * bytesPerRow + 64 * 4 + redChannel] ?? 0,
        };
      };
      const sharp = await read();
      if (compilation !== undefined) {
        expect(countDepthOfField()).toBe(0);
        if (antialias === ANTIALIAS_TAA) expect(countTaa()).toBeGreaterThan(0);
      }
      world
        .addComponent(camera, {
          component: DepthOfField,
          data: {
            focusDistance: 1,
            fStop: 0.7,
            sensorHeight: 0.24,
            maxRadiusPixels: 10,
            blurSide: DepthOfFieldSideValue.both,
          },
        })
        .unwrap();
      const blurred = await read();
      if (compilation !== undefined) expect(countDepthOfField()).toBe(1);
      const inspection = renderer.inspect();
      expect(errors).toEqual([]);
      expect(inspection.capabilities.backendKind).toBe(backend);
      expect(inspection.depthOfField).toMatchObject({
        status: 'active',
        passCount: backend === 'webgpu' ? 6 : 7,
        outputExtent: { width: 64, height: 32 },
        workExtent: { width: 32, height: 16 },
      });
      const passes = inspection.perFramePassNames;
      expect(passes).toContain(backend === 'webgpu' ? 'dof-tiles' : 'dof-tile-influence');
      const dof = passes.indexOf('dof-composite');
      const resolve = passes.indexOf(antialias === ANTIALIAS_TAA ? 'taa-resolve' : 'tsr-analyze');
      expect(dof).toBeGreaterThanOrEqual(0);
      expect(resolve).toBeGreaterThan(dof);
      expect(sharp.inside).toBeGreaterThan(100);
      expect(blurred.inside).toBeGreaterThan(100);
      expect(blurred.outside).toBeGreaterThan(sharp.outside + 8);
    } finally {
      lease.dispose();
    }
  } finally {
    unsubscribe();
    releaseTransforms();
    try {
      await renderer.dispose();
    } finally {
      compilation?.mockRestore();
      canvas.remove();
    }
  }
}, 120_000);
