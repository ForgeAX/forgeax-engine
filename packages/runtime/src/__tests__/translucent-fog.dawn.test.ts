import { mkdirSync, writeFileSync } from 'node:fs';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  type FrameModel,
  openReplay,
  summarizeFrame,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, expect, it } from 'vitest';
import { deviceOptionsForAdapter } from '../../../render/src/assembly/device-feature-admission';
import { translucentViewOffset } from '../../../render/src/record/view-ubo';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { observeNativeDeviceRequests } from './native-device-work.fixture';
import { observeReplaySubmissions } from './native-replay-work.fixture';
import { inspectReplayWorks } from './replay-inspections.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import {
  assertTranslucentFog,
  expectedPanePixel,
  expectedWallPixel,
  PANE_PIXEL,
  readRgba,
  sampleTranslucentFog,
  TRANSLUCENT_FOG_SIZE,
  type TranslucentFogPath,
  WALL_PIXEL,
  wallDepthFoggedPanePixel,
} from './translucent-fog.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
const directory = 'artifacts/translucent-fog/dawn';
const REPLAY_TOLERANCE = 0.03;

function fragmentSource(work: FrameModel['works'][number]): string {
  return work.pipeline.shaders.find((shader) => shader.stage === 'fragment')?.source ?? '';
}

function viewSlotOffsets(work: FrameModel['works'][number]): number[] {
  return work.bindings
    .filter((binding) => binding.groupIndex === 0 && binding.dynamicOffset !== null)
    .map((binding) => binding.dynamicOffset ?? 0);
}

function expectPixel(actual: readonly number[], expected: readonly number[], label: string): void {
  for (let channel = 0; channel < 3; channel++) {
    expect(
      Math.abs((actual[channel] ?? 0) - (expected[channel] ?? 0)),
      `${label}: ${JSON.stringify({ actual, expected })}`,
    ).toBeLessThan(REPLAY_TOLERANCE);
  }
}

/**
 * RHI Debug proof of the composition order: the opaque fog pass runs before
 * the pane, the pane binds the straight-alpha View copy, and a fresh-device
 * replay shows the opaque scene fogged at wall depth before the pane blends
 * its own-depth fog over it.
 */
async function verifyReplay(bytes: Uint8Array, model: FrameModel) {
  const fogWorks = model.works.filter((work) => fragmentSource(work).includes('fog_view'));
  expect(fogWorks).toHaveLength(1);
  const straight = translucentViewOffset('straight');
  const translucentOffsets = new Set(
    (['straight', 'premultiplied', 'additive'] as const).map(translucentViewOffset),
  );
  const paneWorks = model.works.filter((work) => viewSlotOffsets(work).includes(straight));
  expect(paneWorks).toHaveLength(1);
  const fogWork = fogWorks[0];
  const paneWork = paneWorks[0];
  if (fogWork === undefined || paneWork === undefined) throw new Error('missing fog works');
  expect(fragmentSource(paneWork)).toContain('translucent_fog');
  expect(fogWork.workIndex).toBeLessThan(paneWork.workIndex);
  for (const work of model.works) {
    if (work === paneWork) continue;
    for (const offset of viewSlotOffsets(work)) expect(translucentOffsets.has(offset)).toBe(false);
  }
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice(deviceOptionsForAdapter(adapter))).unwrap();
  const replay = (
    await openReplay(decodeTape(bytes).unwrap(), {
      device,
      createShaderModule: webgpu.createShaderModule,
    })
  ).unwrap();
  const submissions = observeReplaySubmissions(device);
  try {
    const inspections = await inspectReplayWorks(replay, [fogWork, paneWork]);
    const read = (index: number) => {
      const attachment = inspections[index]?.attachment;
      expect(attachment?.format).toBe('rgba16float');
      if (attachment === undefined) throw new Error(`missing replay output ${index}`);
      const image = {
        bytes: attachment.bytes,
        metadata: { format: 'rgba16float', bytesPerRow: TRANSLUCENT_FOG_SIZE * 8 },
      };
      return {
        pane: readRgba(image, PANE_PIXEL[0], PANE_PIXEL[1]),
        wall: readRgba(image, WALL_PIXEL[0], WALL_PIXEL[1]),
      };
    };
    const afterFog = read(0);
    const afterPane = read(1);
    submissions.assertMaximum(8);
    expectPixel(afterFog.wall, expectedWallPixel(), 'wall after opaque fog');
    expectPixel(afterPane.wall, expectedWallPixel(), 'wall after pane');
    expectPixel(afterPane.pane, expectedPanePixel(), 'pane after its own-depth fog');
    const falsifier = wallDepthFoggedPanePixel();
    const falsifierGap = Math.max(
      ...[0, 1, 2].map((channel) =>
        Math.abs((afterPane.pane[channel] ?? 0) - (falsifier[channel] ?? 0)),
      ),
    );
    expect(falsifierGap).toBeGreaterThan(REPLAY_TOLERANCE * 4);
    return {
      fogWorkIndex: fogWork.workIndex,
      paneWorkIndex: paneWork.workIndex,
      paneViewOffsets: viewSlotOffsets(paneWork),
      afterFog,
      afterPane,
    };
  } finally {
    submissions.restore();
    (await replay.dispose()).unwrap();
    device.nativeDevice().unwrap().destroy();
  }
}

// Fresh replay devices stay independent; the four live Worlds share only
// the renderer, while sampleTranslucentFog restores profile and disposes leases.
const nativeDevices = observeNativeDeviceRequests();
async function createFogHost() {
  const target = offscreenCanvas(TRANSLUCENT_FOG_SIZE);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = await constructRuntimeRendererHost(
    target.canvas,
    { rhi: recorder.backend.rhi },
    { shaderManifestUrl: manifestUrl },
  );
  if (!host.ok) throw new Error(JSON.stringify(host.error));
  return { target, recorder, host };
}
let sharedHost: ReturnType<typeof createFogHost> | undefined;
afterAll(async () => {
  try {
    if (sharedHost === undefined) return;
    const { target, recorder, host } = await sharedHost;
    (await host.value.renderer.dispose()).unwrap();
    target.destroy();
    (await recorder.dispose()).unwrap();
    nativeDevices.assertMaximum(5);
  } finally {
    nativeDevices.restore();
  }
});

it.each([
  ['forward', 'unlit'],
  ['deferred', 'unlit'],
  ['forward', 'standard'],
  ['deferred', 'standard'],
] as const)(
  'fogs a %s %s translucent pane at its own depth',
  {
    timeout: 180_000,
  },
  async (path: TranslucentFogPath, material) => {
    sharedHost ??= createFogHost();
    const { recorder, host } = await sharedHost;
    mkdirSync(directory, { recursive: true });
    let tape: EncodedTape | undefined;
    const sample = await sampleTranslucentFog(host.value.renderer, {
      path,
      material,
      recorder,
      capture(value) {
        tape = value;
        writeFileSync(`${directory}/${path}-${material}.rhitape`, value.bytes);
      },
    });
    if (tape === undefined) throw new Error('missing translucent-fog capture');
    const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
    writeFileSync(
      `${directory}/${path}-${material}-summary.json`,
      JSON.stringify({ digest: tape.digest, ...summarizeFrame(model) }, null, 2),
    );
    assertTranslucentFog(sample);
    const replay = await verifyReplay(tape.bytes, model);
    writeFileSync(
      `${directory}/${path}-${material}-evidence.json`,
      JSON.stringify(
        {
          backend: 'dawn',
          live: { pane: sample.pane, wall: sample.wall },
          expected: {
            pane: expectedPanePixel(),
            wall: expectedWallPixel(),
            wallDepthFoggedPane: wallDepthFoggedPanePixel(),
          },
          replay,
        },
        null,
        2,
      ),
    );
  },
);
