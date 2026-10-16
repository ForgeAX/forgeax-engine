#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(scriptsDir);
const PACKAGE = '@forgeax/bevy-transparency-3d';
const LABEL = 'bevy transparency 3d';
const targets = [
  ['masked standard', 7],
  ['alpha-to-coverage', 8],
  ['masked unlit', 9],
  ['alpha blended', 10],
];
const selectedTarget = process.env.TRANSPARENCY_DRAW_INDEX === undefined
  ? undefined
  : targets.find(([, drawIdx]) => drawIdx === Number(process.env.TRANSPARENCY_DRAW_INDEX));

if (selectedTarget !== undefined) {
  const [mode, drawIdx] = selectedTarget;
  await verifyDemoCapture({
    pkg: PACKAGE,
    label: `${LABEL} ${mode}`,
    mode: 'structural',
    drawIdx,
    appDir,
    assertTape: assertTransparencyTape,
  });
} else {
  // verifyDemoCapture terminates with its green result, so run each concrete
  // inspection in a child and keep the four checks independent and fresh.
  for (const [, drawIdx] of targets) {
    const exitCode = await runTarget(drawIdx);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      break;
    }
  }
}

function runTarget(drawIdx) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, TRANSPARENCY_DRAW_INDEX: String(drawIdx) },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** @param {{ tape: { events: readonly object[], blobPool: Map<string, ArrayBuffer> } }} input */
function assertTransparencyTape({ tape }) {
  const draws = collectDraws(tape.events);
  const scene = draws.filter(
    (draw) =>
      draw.pass?.colorAttachmentViewHandleIds?.length === 1 &&
      draw.pass?.depthStencilViewHandleId !== undefined &&
      draw.pass?.colorAttachmentResolveTargetHandleIds?.every((handleId) => handleId === null),
  );
  if (scene.length !== 5) {
    throw new Error(`expected five scene draws in the main color pass, got ${scene.length}`);
  }

  const maskedStandard = scene[2];
  const alphaToCoverage = scene[3];
  const maskedUnlit = scene[4];
  const blended = draws.find((draw) => draw.pipeline?.desc?.fragment?.targets?.[0]?.blend !== undefined);
  if (maskedStandard === undefined || alphaToCoverage === undefined || maskedUnlit === undefined || blended === undefined) {
    throw new Error('transparency scene did not retain all four target draws');
  }

  const expected = {
    maskedStandard: { alphaCutoff: 0.5 },
    maskedUnlit: { alphaCutoff: 0.1 },
    alphaToCoverage: true,
    blendDepthWrite: false,
    blendColor: {
      srcFactor: 'src-alpha',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    },
    blendAlpha: {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    },
  };
  if (process.env.FALSIFY === 'transparency-3d-alpha-to-coverage') {
    expected.alphaToCoverage = false;
    console.log('[transparency-3d] FALSIFY=transparency-3d-alpha-to-coverage -- expecting disabled alpha-to-coverage');
  }
  if (process.env.FALSIFY === 'transparency-3d-blend-depth-write') {
    expected.blendDepthWrite = true;
    console.log('[transparency-3d] FALSIFY=transparency-3d-blend-depth-write -- expecting blended depth writes');
  }

  const pipelineById = new Map(
    tape.events
      .filter((event) => event.kind === 'createRenderPipeline')
      .map((event) => [event.handleId, event]),
  );
  const standardPipeline = pipelineById.get(maskedStandard.pipelineHandleId);
  const unlitPipeline = pipelineById.get(maskedUnlit.pipelineHandleId);
  const coveragePipeline = pipelineById.get(alphaToCoverage.pipelineHandleId);
  const blendPipeline = pipelineById.get(blended.pipelineHandleId);
  if (standardPipeline === undefined || unlitPipeline === undefined || coveragePipeline === undefined || blendPipeline === undefined) {
    throw new Error('one or more transparency draw pipelines are missing from the tape');
  }

  if (standardPipeline.vertexShaderModuleHandleId !== standardPipeline.fragmentShaderModuleHandleId) {
    throw new Error('masked standard draw does not use one standard shader module for both stages');
  }
  if (unlitPipeline.vertexShaderModuleHandleId !== unlitPipeline.fragmentShaderModuleHandleId) {
    throw new Error('masked unlit draw does not use one unlit shader module for both stages');
  }
  if (standardPipeline.vertexShaderModuleHandleId === unlitPipeline.vertexShaderModuleHandleId) {
    throw new Error('masked standard and masked unlit draws collapsed to the same shader module');
  }
  if (coveragePipeline.desc?.multisample?.alphaToCoverageEnabled !== expected.alphaToCoverage) {
    throw new Error(
      `alpha-to-coverage pipeline state drifted: expected ${expected.alphaToCoverage}, got ${coveragePipeline.desc?.multisample?.alphaToCoverageEnabled}`,
    );
  }
  if (blendPipeline.desc?.depthStencil?.depthWriteEnabled !== expected.blendDepthWrite) {
    throw new Error(
      `blended pipeline depth writes drifted: expected ${expected.blendDepthWrite}, got ${blendPipeline.desc?.depthStencil?.depthWriteEnabled}`,
    );
  }
  const blend = blendPipeline.desc?.fragment?.targets?.[0]?.blend;
  if (JSON.stringify(blend?.color) !== JSON.stringify(expected.blendColor) || JSON.stringify(blend?.alpha) !== JSON.stringify(expected.blendAlpha)) {
    throw new Error(`blended factors drifted: ${JSON.stringify(blend)}`);
  }

  const materialWrite = tape.events.find(
    (event) =>
      event.kind === 'writeBuffer' &&
      event.handleId?.startsWith('buffer:') &&
      event.handleId?.endsWith(':39') &&
      event.size === 3072,
  );
  if (materialWrite === undefined) {
    throw new Error('material UBO write for masked alpha cutoffs is missing');
  }
  const materialBytes = tape.blobPool.get(materialWrite.dataHash);
  if (materialBytes === undefined) {
    throw new Error(`material UBO blob ${materialWrite.dataHash} is missing`);
  }
  const materialFloats = new Float32Array(materialBytes);
  const readAlphaCutoff = (draw) => {
    const offset = draw.materialDynamicOffset;
    if (!Number.isInteger(offset) || offset < 0 || offset % 512 !== 0) return undefined;
    return materialFloats[offset / 4 + 17];
  };
  const standardCutoff = readAlphaCutoff(maskedStandard);
  const unlitCutoff = readAlphaCutoff(maskedUnlit);
  if (
    standardCutoff === undefined ||
    unlitCutoff === undefined ||
    Math.abs(standardCutoff - expected.maskedStandard.alphaCutoff) > 1e-6 ||
    Math.abs(unlitCutoff - expected.maskedUnlit.alphaCutoff) > 1e-6
  ) {
    throw new Error(`masked alpha cutoffs drifted: standard=${standardCutoff} unlit=${unlitCutoff}`);
  }
}

function collectDraws(events) {
  const pipelines = new Map();
  const draws = [];
  const passDrawCounts = new Map();
  let currentPipelineHandleId;
  let currentPassHandleId;
  let currentMaterialDynamicOffset;
  const passes = new Map();

  for (const event of events) {
    if (event.kind === 'createRenderPipeline') {
      pipelines.set(event.handleId, event);
    } else if (event.kind === 'beginRenderPass') {
      currentPassHandleId = event.passHandleId;
      passDrawCounts.set(currentPassHandleId, 0);
      passes.set(currentPassHandleId, event);
    } else if (event.kind === 'setPipeline') {
      currentPipelineHandleId = event.pipelineHandleId;
    } else if (event.kind === 'setBindGroup' && event.index === 1) {
      currentMaterialDynamicOffset = event.dynamicOffsets?.[0];
    } else if (event.kind === 'drawIndexed' || event.kind === 'draw') {
      const passDrawIndex = passDrawCounts.get(currentPassHandleId);
      if (passDrawIndex !== undefined) passDrawCounts.set(currentPassHandleId, passDrawIndex + 1);
      draws.push({
        event,
        passHandleId: currentPassHandleId,
        passDrawIndex,
        pass: passes.get(currentPassHandleId),
        pipelineHandleId: currentPipelineHandleId,
        pipeline: pipelines.get(currentPipelineHandleId),
        materialDynamicOffset: currentMaterialDynamicOffset,
      });
    }
  }
  return draws;
}
