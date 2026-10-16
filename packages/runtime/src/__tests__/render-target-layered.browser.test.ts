import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  assertLayeredEvidence,
  assertReplayEvidence,
  LAYERED_CANVAS_SIZE,
  layerSheet,
  replayLayeredTapes,
  toSrgbBytes,
  verifyLayeredTargets,
} from './render-target-layered.fixture';

const directory = 'artifacts/pr-evidence/rt-3d-array/browser';

async function save(name: string, bytes: Uint8Array): Promise<void> {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  await commands.writeFile(`${directory}/${name}`, btoa(binary), 'base64');
}

async function png(rgba: Uint8Array, size: number, zoom: number): Promise<Uint8Array> {
  const source = new OffscreenCanvas(size, size);
  source
    .getContext('2d')
    ?.putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
  const scaled = new OffscreenCanvas(size * zoom, size * zoom);
  const context = scaled.getContext('2d');
  if (context === null) throw new Error('2d context unavailable');
  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0, size * zoom, size * zoom);
  return new Uint8Array(await (await scaled.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

it('renders 3D slices and array layers, samples them in a material, reads back and replays on Browser WebGPU', {
  timeout: 240_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = LAYERED_CANVAS_SIZE;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = await constructRuntimeRendererHost(canvas, { rhi: recorder.backend.rhi });
  if (!host.ok) throw host.error;
  try {
    const evidence = await verifyLayeredTargets(host.value.renderer, recorder);
    await save('canvas.png', await png(toSrgbBytes(evidence.canvas), LAYERED_CANVAS_SIZE, 2));
    await save(
      'target-layers.png',
      await png(
        toSrgbBytes(layerSheet(evidence.volumeLayers, evidence.arrayLayers)),
        LAYERED_CANVAS_SIZE,
        2,
      ),
    );
    assertLayeredEvidence(evidence);
    const replay = await replayLayeredTapes(webgpu, evidence);
    const json = {
      backend: 'browser-webgpu',
      frames: evidence.frames,
      readbackLayers: evidence.readbackLayers,
      canvasQuads: evidence.canvasQuads,
      falsifier: evidence.falsifier,
      replay: {
        volumeDigest: replay.volumeDigest,
        arrayDigest: replay.arrayDigest,
        volumeWrites: replay.volumeWrites,
        arrayWrites: replay.arrayWrites,
        replayLayers: replay.replayLayers,
        maxLiveReplayDelta: replay.maxLiveReplayDelta,
        falsifier: replay.falsifier,
      },
    };
    await save('evidence.json', new TextEncoder().encode(JSON.stringify(json, null, 2)));
    assertReplayEvidence(replay);
  } finally {
    await host.value.renderer.dispose();
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
});
