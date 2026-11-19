import { mkdirSync, writeFileSync } from 'node:fs';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_MSAA_FXAA,
  BLOOM_DISABLED,
  Camera,
  CameraView,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  summarizePasses,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

function resourceLabel(metadata: unknown): string | undefined {
  if (metadata === null || typeof metadata !== 'object' || !('desc' in metadata)) return;
  const desc = metadata.desc;
  if (desc === null || typeof desc !== 'object' || !('label' in desc)) return;
  return typeof desc.label === 'string' ? desc.label : undefined;
}

/** Exercise the public Renderer, native surface, graph and exact receipt readback together. */
it.each([
  false,
  true,
])('outputs a full CameraView directly and preserves composed/observed pixels across route changes (UI=%s)', {
  timeout: 180_000,
}, async (ui) => {
  const width = 64,
    height = 32;
  const target = offscreenCanvas(width, height);
  const recorder = attachRecorder(webgpu).unwrap();
  const manifestUrl = URL.createObjectURL(
    new Blob([JSON.stringify(await buildEngineShaderTemplateManifest())], {
      type: 'application/json',
    }),
  );
  const host = renderValue(
    await constructRuntimeRendererHost(
      target.canvas,
      {
        rhi: recorder.backend.rhi,
        ...(ui
          ? {
              ui: {
                kind: 'rgba' as const,
                paint: () => {
                  const pixels = new Uint8Array(width * height * 4);
                  for (let y = 0; y < 8; y++)
                    for (let x = 0; x < 8; x++) pixels.set([0, 128, 0, 128], (y * width + x) * 4);
                  return pixels;
                },
              },
            }
          : {}),
        rhiInstrumentation: {
          resolveSurfaceDevice: (device) =>
            ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
        },
      },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  const { renderer, assets } = host;
  const world = new World({ assets });
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  renderValue(renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'forward' }));
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const material = assets.create(Materials.unlit([0.8, 0.2, 0.05, 1])).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          near: 0.1,
          far: 10,
          antialias: ui ? ANTIALIAS_MSAA_FXAA : ANTIALIAS_FXAA,
          bloom: BLOOM_DISABLED,
          tonemap: 0,
          clearColor: [0.02, 0.03, 0.04, 1],
        },
      },
      { component: CameraView, data: {} },
    )
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  let captured: EncodedTape | undefined;
  const draw = async (observe = false, capture = false) => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    return completeReadyFrame(async () => {
      if (observe) {
        if (renderer.requestObservation === undefined)
          throw Error('Missing receipt observation producer');
        renderValue(renderer.requestObservation(['final-display']));
      }
      const abort = new AbortController();
      const tape = capture ? recorder.captureFrame({ signal: abort.signal }) : undefined;
      try {
        if (tape !== undefined) (await recorder.frameBoundary()).unwrap();
        const receipt = renderValue(renderer.draw({ source: lease }));
        if (tape !== undefined) {
          (await recorder.frameBoundary()).unwrap();
          const result = (await tape).unwrap();
          if (receipt.presentation === 'ready') captured = result;
        }
        return receipt;
      } finally {
        abort.abort();
        await tape;
      }
    });
  };
  const picture = async () => {
    const receipt = await draw(true, true);
    const observation = renderValue(
      await renderer.observe(receipt, { include: ['final-display'] }),
    ).observations?.filter((row) => row.domain === 'final-display');
    expect(observation).toHaveLength(1);
    const image = observation?.at(0);
    if (image === undefined || captured === undefined) throw Error('Missing native picture/tape');
    expect(image.metadata).toMatchObject({ width, height });
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      pixels.set(
        image.bytes.subarray(
          y * image.metadata.bytesPerRow,
          y * image.metadata.bytesPerRow + width * 4,
        ),
        y * width * 4,
      );
    const model = buildFrameModel(decodeTape(captured.bytes).unwrap());
    return {
      pixels,
      tape: captured.bytes,
      passes: summarizePasses(model).map((pass) => pass.label),
      model,
    };
  };
  try {
    for (let frame = 0; frame < 60; frame++) await draw();
    const direct = await picture();
    expect(direct.passes).not.toContain('camera-view-composite');
    expect(direct.passes.includes('screen-ui-composite')).toBe(ui);
    if (ui) expect(direct.pixels[1]).toBeGreaterThan(80);
    expect(
      direct.model.resources.some((row) => {
        const label = resourceLabel(row.descriptor);
        return label !== undefined && label.startsWith('camera:') && label.endsWith(':output');
      }),
    ).toBe(false);
    world.set(camera, CameraView, { updateInterval: 2 }).unwrap();
    const composed = await picture();
    expect(composed.passes).toContain('camera-view-composite');
    world.set(camera, CameraView, { updateInterval: 1 }).unwrap();
    const restored = await picture();
    expect(restored.passes).not.toContain('camera-view-composite');
    for (const candidate of [composed, restored]) {
      expect(candidate.pixels.length).toBe(direct.pixels.length);
      for (let i = 0; i < direct.pixels.length; i++)
        expect(
          Math.abs(Number(candidate.pixels[i]) - Number(direct.pixels[i])),
        ).toBeLessThanOrEqual(1);
    }
    const light = (offset: number) =>
      [0, 1, 2].reduce((sum, c) => sum + Number(direct.pixels[offset + c]), 0);
    expect(light(((height / 2) * width + width / 2) * 4)).toBeGreaterThan(light(0) + 30);
    expect(errors).toEqual([]);
    const directory = `artifacts/single-view-surface/${ui ? 'ui' : 'scene'}`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/direct.rhitape`, direct.tape);
    writeFileSync(`${directory}/composed.rhitape`, composed.tape);
    writeFileSync(`${directory}/restored.rhitape`, restored.tape);
  } finally {
    off();
    renderValue(await renderer.dispose());
    (await recorder.dispose()).unwrap();
    target.destroy();
    URL.revokeObjectURL(manifestUrl);
  }
});
