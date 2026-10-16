#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/bevy-blend-modes',
  label: 'bevy blend-modes',
  mode: 'structural',
  appDir: dirname(scriptsDir),
  assertTape({ tape }) {
    const draws = collectDraws(tape.events);
    const spheres = draws.filter(
      (draw) =>
        draw.event.kind === 'drawIndexed' &&
        draw.event.indexCount === 2880 &&
        draw.pass?.colorAttachmentViewHandleIds?.length === 1 &&
        draw.pass?.depthStencilViewHandleId !== undefined &&
        draw.pass?.colorAttachmentResolveTargetHandleIds?.every((handleId) => handleId === null),
    );
    if (spheres.length !== 5) {
      throw new Error(`expected five sphere draws in the main color pass, got ${spheres.length}`);
    }

    const expected = [
      { name: 'opaque', blend: undefined, depthWriteEnabled: true },
      {
        name: 'standard-alpha',
        blend: alphaBlend('src-alpha', 'one-minus-src-alpha'),
        depthWriteEnabled: true,
      },
      {
        name: 'premultiplied-alpha',
        blend: alphaBlend('one', 'one-minus-src-alpha'),
        depthWriteEnabled: true,
      },
      {
        name: 'additive',
        blend: alphaBlend('one', 'one'),
        depthWriteEnabled: true,
      },
      {
        name: 'multiply',
        blend: alphaBlend('dst', 'zero'),
        depthWriteEnabled: true,
      },
    ];
    if (process.env.FALSIFY === 'blend-modes-duplicate-multiply') {
      expected[4] = { ...expected[3], name: 'multiply' };
      console.log('[blend-modes] FALSIFY=blend-modes-duplicate-multiply -- expecting additive factors for multiply');
    }
    if (process.env.FALSIFY === 'blend-modes-opaque-alpha') {
      expected[0] = { ...expected[1], name: 'opaque' };
      console.log('[blend-modes] FALSIFY=blend-modes-opaque-alpha -- expecting alpha factors for opaque');
    }

    const actual = spheres.map((draw) => ({
      blend: draw.pipeline?.desc?.fragment?.targets?.[0]?.blend,
      depthWriteEnabled: draw.pipeline?.desc?.depthStencil?.depthWriteEnabled,
      pipelineHandleId: draw.pipelineHandleId,
    }));
    console.log(`[blend-modes] sphere pipeline contracts=${JSON.stringify(actual)}`);

    const signatures = actual.map((pipeline) => JSON.stringify({ blend: pipeline.blend, depthWriteEnabled: pipeline.depthWriteEnabled }));
    if (new Set(signatures).size !== expected.length) {
      throw new Error(`sphere pipeline contracts are not five distinct states: ${JSON.stringify(signatures)}`);
    }
    for (let i = 0; i < expected.length; i += 1) {
      const wanted = expected[i];
      const got = actual[i];
      if (JSON.stringify(got.blend) !== JSON.stringify(wanted.blend) || got.depthWriteEnabled !== wanted.depthWriteEnabled) {
        throw new Error(
          `${wanted.name} pipeline drifted: expected=${JSON.stringify(wanted)} got=${JSON.stringify(got)}`,
        );
      }
    }
  },
});

function alphaBlend(srcFactor, dstFactor) {
  return {
    color: { srcFactor, dstFactor, operation: 'add' },
    alpha: { srcFactor, dstFactor, operation: 'add' },
  };
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
        pipelineHandleId: currentPipelineHandleId,
        pipeline: pipelines.get(currentPipelineHandleId),
      });
    }
  }
  return draws;
}
