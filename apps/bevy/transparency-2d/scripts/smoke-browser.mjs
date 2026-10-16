#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const transparentSpriteDraw = 2;

await verifyDemoCapture({
  pkg: '@forgeax/bevy-transparency-2d',
  label: 'bevy transparency 2d',
  mode: 'structural',
  drawIdx: transparentSpriteDraw,
  appDir: dirname(scriptsDir),
  assertTape({ tape }) {
    const pipelines = new Map();
    const draws = [];
    let pipelineHandleId;
    for (const event of tape.events) {
      if (event.kind === 'createRenderPipeline') pipelines.set(event.handleId, event.desc);
      if (event.kind === 'setPipeline') pipelineHandleId = event.pipelineHandleId;
      if (event.kind === 'draw' || event.kind === 'drawIndexed') {
        draws.push({ event, pipeline: pipelines.get(pipelineHandleId) });
      }
    }
    const transparentSpriteDraws = draws.filter(({ event }) => event.kind === 'drawIndexed');
    const selected = transparentSpriteDraws[transparentSpriteDraw];
    const target = selected?.pipeline?.fragment?.targets?.[0];
    const blend = target?.blend;
    const expected = {
      drawKind: 'drawIndexed',
      indexCount: 6,
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      depthWriteEnabled: false,
    };
    const actual = {
      drawKind: selected?.event?.kind,
      indexCount: selected?.event?.indexCount,
      targetFormat: target?.format,
      color: {
        srcFactor: blend?.color?.srcFactor,
        dstFactor: blend?.color?.dstFactor,
        operation: blend?.color?.operation,
      },
      alpha: {
        srcFactor: blend?.alpha?.srcFactor,
        dstFactor: blend?.alpha?.dstFactor,
        operation: blend?.alpha?.operation,
      },
      depthWriteEnabled: selected?.pipeline?.depthStencil?.depthWriteEnabled,
    };
    if (transparentSpriteDraws.length !== 3) {
      throw new Error(`expected 3 transparent sprite draws, got ${transparentSpriteDraws.length}`);
    }
    const targetFormats = new Set(['bgra8unorm', 'rgba16float']);
    const blendEvidenceMatches =
      actual.drawKind === expected.drawKind &&
      actual.indexCount === expected.indexCount &&
      actual.color !== undefined &&
      JSON.stringify(actual.color) === JSON.stringify(expected.color) &&
      actual.alpha !== undefined &&
      JSON.stringify(actual.alpha) === JSON.stringify(expected.alpha) &&
      actual.depthWriteEnabled === expected.depthWriteEnabled;
    if (!targetFormats.has(actual.targetFormat) || !blendEvidenceMatches) {
      throw new Error(`selected draw ${transparentSpriteDraw} alpha/blend mismatch: ${JSON.stringify({ expected, actual })}`);
    }
    console.log(`[bevy transparency 2d] selected draw ${transparentSpriteDraw} alpha/blend evidence=${JSON.stringify(actual)}`);
  },
});
