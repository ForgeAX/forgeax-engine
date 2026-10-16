#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/bevy-camera-pan',
  label: 'bevy camera-pan',
  mode: 'structural',
  capturePrepareHook: '__prepareCameraPanCapture',
  appDir: dirname(scriptsDir),
  assertTape: assertCameraPanTape,
});

/** @param {{ tape: { events: readonly object[], blobPool: Map<string, ArrayBuffer> } }} input */
function assertCameraPanTape({ tape }) {
  const draws = collectDraws(tape.events);
  const scene = draws.filter(
    (draw) =>
      draw.pass?.colorAttachmentViewHandleIds?.length === 1 &&
      typeof draw.pass.depthStencilViewHandleId === 'string',
  );
  if (scene.length !== 4 || scene.some(({ event }) => event.kind !== 'drawIndexed')) {
    throw new Error(`expected four indexed cube draws in the camera-pan scene, got ${scene.length}`);
  }

  const viewBgl = tape.events.find(
    (event) => event.kind === 'createBindGroupLayout' && event.desc?.label === 'pbr-view-bgl',
  );
  const viewEntry = viewBgl?.desc?.entries?.find((entry) => entry.binding === 0);
  if (viewEntry?.buffer?.type !== 'uniform') {
    throw new Error('pbr-view-bgl binding 0 is not the canonical uniform View binding');
  }
  const viewGroup = tape.events.find(
    (event) => event.kind === 'createBindGroup' && event.layoutHandleId === viewBgl?.handleId,
  );
  const viewBufferId = viewGroup?.resourceHandleIds?.[0];
  const viewBuffer = tape.events.find(
    (event) => event.kind === 'createBuffer' && event.handleId === viewBufferId,
  );
  if (viewBuffer?.desc?.size !== 784) {
    throw new Error(`expected 784B pbr View UBO, got ${JSON.stringify(viewBuffer?.desc)}`);
  }

  const viewWrite = [...tape.events]
    .reverse()
    .find((event) => event.kind === 'writeBuffer' && event.handleId === viewBufferId && event.size === 784);
  const viewBytes = viewWrite === undefined ? undefined : readBlob(tape, viewWrite.dataHash);
  if (viewBytes === undefined || viewBytes.byteLength !== 784) {
    throw new Error('pbr View UBO write blob is missing from the self-contained tape');
  }
  const viewFloats = new Float32Array(viewBytes.buffer, viewBytes.byteOffset, viewBytes.byteLength / 4);
  const cameraPosition = [viewFloats[24], viewFloats[25], viewFloats[26]];
  if (
    cameraPosition.some((value, index) => !Number.isFinite(value) || Math.abs(value - [0, 0, 8][index]) > 0.01)
  ) {
    throw new Error(`camera position did not reach the View UBO as [0,0,8]: ${JSON.stringify(cameraPosition)}`);
  }
  const worldViewProj = viewFloats.slice(0, 16);
  if (worldViewProj.some((value) => !Number.isFinite(value)) || worldViewProj.every((value) => value === 0)) {
    throw new Error('camera worldViewProj matrix is empty or non-finite in the View UBO');
  }

  const pbrDraws = scene.filter(({ pipeline }) => pipeline?.desc?.fragment?.targets?.length === 1);
  if (pbrDraws.length !== 4) {
    throw new Error(`expected four material pipeline-backed camera draws, got ${pbrDraws.length}`);
  }
  console.log(
    `[camera-pan] View UBO lineage camera=${JSON.stringify(cameraPosition)} ` +
      `draws=${pbrDraws.length} matrix0=${worldViewProj[0]?.toFixed(4)} accepted`,
  );
}

function readBlob(tape, hash) {
  const blob = tape.blobPool.get(hash);
  return blob === undefined ? undefined : new Uint8Array(blob);
}

function collectDraws(events) {
  const pipelines = new Map();
  const passes = new Map();
  const draws = [];
  let currentPipelineHandleId;
  let currentPassHandleId;

  for (const event of events) {
    if (event.kind === 'createRenderPipeline') {
      pipelines.set(event.handleId, event);
    } else if (event.kind === 'beginRenderPass') {
      currentPassHandleId = event.passHandleId;
      passes.set(currentPassHandleId, event);
    } else if (event.kind === 'setPipeline') {
      currentPipelineHandleId = event.pipelineHandleId;
    } else if (event.kind === 'draw' || event.kind === 'drawIndexed') {
      draws.push({
        event,
        pass: passes.get(currentPassHandleId),
        pipeline: pipelines.get(currentPipelineHandleId),
      });
    }
  }
  return draws;
}
