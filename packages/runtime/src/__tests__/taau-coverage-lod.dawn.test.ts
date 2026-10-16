import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  DynamicResolution,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { LOD_SIZE, value } from './lod-transition.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());

it('draws TAAU output coverage for GPU-claimed LOD meshes through indirect rows', {
  timeout: 120_000,
}, async () => {
  let target: GPUTexture | undefined;
  const canvas = {
    width: LOD_SIZE,
    height: LOD_SIZE,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        target?.destroy();
        target = options.device.createTexture({
          size: [LOD_SIZE, LOD_SIZE],
          format: options.format,
          usage: 0x11,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const host = value(
    await constructRuntimeRendererHost(
      canvas,
      { rhi: recorder.backend.rhi },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  const { renderer, assets } = host;
  const world = new World();
  const lease = value(renderer.attach(world));
  value(renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'forward', ssao: false }));
  try {
    const plane = createPlaneGeometry(2, 2, 1, 1).unwrap();
    const lowerGuid = assets.parseGuid('019a0000-0000-7000-8000-000000000322');
    assets.catalog(lowerGuid, plane).unwrap();
    const mesh = world.allocSharedRef('MeshAsset', {
      ...plane,
      lods: [{ mesh: lowerGuid, screenCoverage: 0.01 }],
      lodHysteresis: 0,
    });
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [1, 1, 1, 1], renderState: { cullMode: 'none' } }),
    );
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: {
            projection: 1,
            left: -2,
            right: 2,
            bottom: -2,
            top: 2,
            near: 0.1,
            far: 20,
            aspect: 1,
            antialias: 3,
            clearColor: [0, 0, 0, 1],
          },
        },
        {
          component: DynamicResolution,
          data: { targetGpuMs: 16.67, minScale: 0.5, maxScale: 0.5 },
        },
      )
      .unwrap();
    world
      .spawn({ component: DirectionalLight, data: { direction: [0, 0, -1], intensity: 3 } })
      .unwrap();
    const frame = async (capture: boolean) => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const pending = capture ? recorder.captureFrame() : undefined;
      if (pending) (await recorder.frameBoundary()).unwrap();
      const drawn = value(
        renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
      );
      value(await drawn.completed);
      if (pending) (await recorder.frameBoundary()).unwrap();
      return pending;
    };
    for (let i = 0; i < 4; i++) await frame(false);
    expect(renderer.inspect().perFramePassNames).toContain('standard-scene-coverage');
    const pending = await frame(true);
    if (!pending) throw new Error('Missing TAAU coverage capture');
    const tape = decodeTape((await pending).unwrap().bytes).unwrap();
    const model = buildFrameModel(tape);
    const coverage = model.works.filter(
      (work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_temporal') &&
        JSON.stringify(tape.events[model.passes[work.passIndex]?.beginEventIndex ?? -1]).includes(
          'standard-scene-coverage',
        ),
    );
    // The direct recorder would issue drawIndexed here; the claimed LOD
    // submesh must reuse the culled GPU-driven indirect rows instead: one
    // stable row per LOD level, the unselected one with zero instances.
    expect(coverage.map((work) => work.kind)).toEqual([
      'drawIndexedIndirect',
      'drawIndexedIndirect',
    ]);
    const work = coverage.at(-1);
    if (!work) throw new Error('Missing TAAU coverage work');
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const attachment = (await replay.inspectWork(work.workIndex, ['pixels'])).unwrap().attachment;
      if (!attachment) throw new Error('Missing TAAU coverage readback');
      expect(attachment.format).toBe('rgba16float');
      const row = attachment.bytes.length / LOD_SIZE;
      const at = (x: number, y: number) =>
        new DataView(attachment.bytes.buffer, attachment.bytes.byteOffset).getUint16(
          y * row + x * 8 + 4,
          true,
        );
      // Output-resolution coverage: the plane spans [-1, 1] of a [-2, 2] view.
      for (const [x, y] of [
        [64, 64],
        [40, 40],
        [88, 88],
      ] as const)
        expect(at(x, y), `covered ${x},${y}`).toBeLessThan(0x8000);
      for (const [x, y] of [
        [4, 4],
        [123, 64],
        [64, 123],
      ] as const)
        expect(at(x, y), `uncovered ${x},${y}`).toBe(0xbc00);
    } finally {
      (await replay.dispose()).unwrap();
    }
  } finally {
    lease.dispose();
    host.renderer.dispose();
    (await recorder.dispose()).unwrap();
    target?.destroy();
  }
});
