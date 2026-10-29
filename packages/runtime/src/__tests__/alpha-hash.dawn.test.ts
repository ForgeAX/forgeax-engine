import { mkdirSync, writeFileSync } from 'node:fs';
import { halfFloat } from '@forgeax/engine-math';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  type ReplayReadbackResult,
  summarizeFrame,
  workOutputs,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, expect, it } from 'vitest';
import { deviceOptionsForAdapter } from '../../../render/src/assembly/device-feature-admission';
import { constructRuntimeRendererHost } from '../renderer-host';
import { ALPHA_HASH_SIZE, verifyAlphaHash } from './alpha-hash.fixture';
import { observeNativeDeviceRequests } from './native-device-work.fixture';
import { observeReplaySubmissions } from './native-replay-work.fixture';
import { describeReplayWork } from './replay-inspections.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
// Coverage and oblique-depth statistics retain thousands of shadow samples;
// the color lattice and every temporal frame keep their original dimensions.
const SHADOW_MAP_SIZE = 128;

function alphaShadowEvidence(shadowAttachment: ReplayReadbackResult, reverse: boolean) {
  const shadowWidth = shadowAttachment.width ?? 0;
  const shadowHeight = shadowAttachment.height ?? 0;
  const shadowData = new DataView(
    shadowAttachment.bytes.buffer,
    shadowAttachment.bytes.byteOffset,
    shadowAttachment.bytes.byteLength,
  );

  let minX = shadowWidth,
    minY = shadowHeight,
    maxX = 0,
    maxY = 0,
    covered = 0,
    minDepth = 1,
    maxDepth = 0,
    invalidShadowPixels = 0;
  for (let y = 0; y < shadowHeight; y++)
    for (let x = 0; x < shadowWidth; x++) {
      const value = shadowData.getFloat32((y * shadowWidth + x) * 4, true);
      if (!Number.isFinite(value)) invalidShadowPixels++;
      if (reverse ? value > 0 : value < 1) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        covered++;
        minDepth = Math.min(minDepth, value);
        maxDepth = Math.max(maxDepth, value);
      }
    }
  expect(invalidShadowPixels, 'every shadow texel is finite').toBe(0);
  expect(maxDepth - minDepth, 'oblique light projects a depth slope').toBeGreaterThan(0.01);
  const shadowCoverage = covered / ((maxX - minX + 1) * (maxY - minY + 1));
  expect(Math.abs(shadowCoverage - 0.5), `shadow coverage=${shadowCoverage}`).toBeLessThan(0.08);
  return {
    coverage: shadowCoverage,
    depthRange: [minDepth, maxDepth],
    bounds: [minX, minY, maxX, maxY],
  };
}

const nativeDevices = observeNativeDeviceRequests();
afterAll(() => {
  try {
    nativeDevices.assertMaximum(12);
  } finally {
    nativeDevices.restore();
  }
});

it.each([
  { kind: 'standard', taaRenderPath: 'forward' },
  { kind: 'unlit', taaRenderPath: 'forward' },
  { kind: 'skin', taaRenderPath: 'forward' },
  { kind: 'standard', taaRenderPath: 'deferred' },
  { kind: 'skin', taaRenderPath: 'deferred' },
] as const)('alpha hash $kind / TAA $taaRenderPath: coverage, temporal stability and fresh RHI replay', {
  timeout: 180_000,
}, async ({ kind, taaRenderPath }) => {
  let texture: GPUTexture | undefined;
  const canvas = {
    width: ALPHA_HASH_SIZE,
    height: ALPHA_HASH_SIZE,
    getContext: () => ({
      configure: (options: GPUCanvasConfiguration) => {
        texture?.destroy();
        texture = options.device.createTexture({
          size: [ALPHA_HASH_SIZE, ALPHA_HASH_SIZE],
          format: options.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure: () => {},
      getCurrentTexture: () => texture,
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const constructed = await constructRuntimeRendererHost(
    canvas,
    { rhi: recorder.backend.rhi },
    { shaderManifestUrl: manifestUrl },
  );
  if (!constructed.ok) throw new Error(JSON.stringify(constructed.error));
  const host = constructed.value;
  const directory = `artifacts/alpha-hash/${kind}${taaRenderPath === 'deferred' ? '-taa-deferred' : ''}`;
  mkdirSync(directory, { recursive: true });
  try {
    const evidence = await verifyAlphaHash(host.renderer, host.assets, {
      kind,
      taaRenderPath,
      shadowMapSize: SHADOW_MAP_SIZE,
      recorder,
      image(name, bytes, metadata) {
        writeFileSync(`${directory}/${name}.bin`, bytes);
        writeFileSync(`${directory}/${name}.json`, JSON.stringify(metadata, null, 2));
      },
      captureIndependent(encoded) {
        writeFileSync(`${directory}/independent-alpha.rhitape`, encoded.bytes);
      },
      async capture(encoded, live) {
        const tape = decodeTape(encoded.bytes).unwrap();
        const model = buildFrameModel(tape);
        expect(host.renderer.inspect().directionalShadow).toMatchObject({
          mapSize: SHADOW_MAP_SIZE,
          cascadeCount: 1,
        });
        if (
          model.works.some((work) =>
            work.pipeline.shaders.some((shader) => shader.source?.includes('fn blendTaaHistory')),
          )
        ) {
          writeFileSync(`${directory}/temporal-frame.rhitape`, encoded.bytes);
          const producer = model.works.find((work) =>
            work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_gbuffer'),
          );
          expect(producer).toBeDefined();
          if (!producer?.attachments) throw new Error('Missing Deferred temporal producer');
          expect(producer.attachments.colorViewHandleIds).toHaveLength(7);
          const temporalId = producer.attachments.colorViewHandleIds[6];
          if (!temporalId) throw new Error('Missing merged temporal attachment');
          const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
          const device = (await adapter.requestDevice(deviceOptionsForAdapter(adapter))).unwrap();
          const replay = (
            await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
          ).unwrap();
          try {
            const temporal = (
              await replay.readResourceAtWork(temporalId, producer.workIndex)
            ).unwrap();
            expect(temporal.format).toBe('rgba16float');
            writeFileSync(`${directory}/scene-temporal.rgba16f`, temporal.bytes);
            const values = new DataView(
              temporal.bytes.buffer,
              temporal.bytes.byteOffset,
              temporal.bytes.byteLength,
            );
            let covered = 0,
              maximumReactive = 0;
            for (let offset = 0; offset < temporal.bytes.byteLength; offset += 8) {
              if (halfFloat.f16ToF32(values.getUint16(offset + 4, true)) < 0) continue;
              covered++;
              maximumReactive = Math.max(
                maximumReactive,
                halfFloat.f16ToF32(values.getUint16(offset + 6, true)),
              );
            }
            writeFileSync(
              `${directory}/temporal-metadata.json`,
              JSON.stringify(
                {
                  digest: encoded.digest,
                  workIndex: producer.workIndex,
                  extent: [temporal.width, temporal.height],
                  covered,
                  maximumReactive,
                  oracle: 'Stationary alpha-hash coverage is sampling, not source reactivity',
                },
                null,
                2,
              ),
            );
            expect(covered).toBeGreaterThan(1000);
            expect(maximumReactive).toBe(0);
          } finally {
            (await replay.dispose()).unwrap();
            device.nativeDevice().unwrap().destroy();
          }
          return;
        }
        writeFileSync(`${directory}/frame.rhitape`, encoded.bytes);
        writeFileSync(
          `${directory}/summary.json`,
          JSON.stringify({ digest: encoded.digest, ...summarizeFrame(model) }, null, 2),
        );
        const geometry = model.works.filter(
          (work) =>
            work.pipeline.shaders.some(
              (shader) =>
                shader.stage === 'fragment' &&
                (shader.entryPoint === 'fs_main' || shader.entryPoint === 'fs_opaque'),
            ) && work.vertexBuffers.length > 0,
        );
        expect(geometry.length).toBeGreaterThan(0);
        const color = geometry.find((work) => work.attachments?.colorViewHandleIds.length !== 0);
        if (color === undefined) throw new Error('Missing recorded color draw');
        expect(JSON.stringify(color.pipeline.descriptor)).toContain('depthWriteEnabled');
        expect(color.pipeline.shaders.some((shader) => shader.source?.includes('alphaHash'))).toBe(
          true,
        );
        const shadow = model.works.find((work) =>
          work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_shadow'),
        );
        expect(shadow, 'real shadow work must be recorded').toBeDefined();
        expect(
          shadow?.pipeline.shaders.some((shader) => shader.source?.includes('alphaHash')),
        ).toBe(true);
        const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
        const device = (await adapter.requestDevice(deviceOptionsForAdapter(adapter))).unwrap();
        const replay = (
          await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
        ).unwrap();
        const submissions = observeReplaySubmissions(device);
        try {
          const output = workOutputs(color).find((row) => row.role === 'color');
          const depthId = color.attachments?.depthStencilViewHandleId;
          const shadowDepth = shadow?.attachments?.depthStencilViewHandleId;
          if (
            output === undefined ||
            depthId === undefined ||
            shadow === undefined ||
            shadowDepth === undefined
          )
            throw new Error('Missing recorded color/depth/shadow outputs');
          const reads = (
            await replay.readAtWorks([
              { ...output.request, workIndex: color.workIndex },
              {
                resourceId: depthId,
                workIndex: color.workIndex,
                subresource: { mipLevel: 0, arrayLayer: 0, aspect: 'depth-only' },
              },
              {
                resourceId: shadowDepth,
                workIndex: shadow.workIndex,
                subresource: { mipLevel: 0, arrayLayer: 0, aspect: 'depth-only' },
              },
            ])
          ).unwrap();
          const attachment = reads[0]?.unwrap();
          const depth = reads[1];
          const shadowPixels = reads[2];
          expect(attachment?.format).toBe('rgba16float');
          if (attachment === undefined) throw new Error('missing replay color');
          expect(attachment.provenance.selectedWorkIndex).toBe(color.workIndex);
          const inspected = describeReplayWork(color, attachment);
          submissions.assertMaximum(14);
          writeFileSync(`${directory}/replay-color.rgba16f`, attachment.bytes);
          const data = new DataView(
            attachment.bytes.buffer,
            attachment.bytes.byteOffset,
            attachment.bytes.byteLength,
          );
          let index = 0;
          let coverageMismatches = 0;
          for (let y = 16; y < ALPHA_HASH_SIZE - 16; y++)
            for (let x = 16; x < ALPHA_HASH_SIZE - 16; x++) {
              if (
                data.getUint16((y * ALPHA_HASH_SIZE + x) * 8, true) > 0 !==
                (live[index++] ?? 0) > 0
              )
                coverageMismatches++;
            }
          expect(coverageMismatches, 'every replay pixel preserves alpha-hash coverage').toBe(0);
          writeFileSync(
            `${directory}/inspection.json`,
            JSON.stringify(
              {
                digest: encoded.digest,
                colorWork: color.workIndex,
                shadowWork: shadow?.workIndex,
                pipeline: inspected.pipeline,
                bindings: inspected.bindings,
                depth: depth?.ok ? { ...depth.value, bytes: Array.from(depth.value.bytes) } : depth,
                shadow: shadowPixels?.ok
                  ? { ...shadowPixels.value, bytes: Array.from(shadowPixels.value.bytes) }
                  : shadowPixels,
              },
              null,
              2,
            ),
          );
          expect(depth?.ok, JSON.stringify(depth?.ok ? {} : depth)).toBe(true);
          expect(shadowPixels?.ok, JSON.stringify(shadowPixels?.ok ? {} : shadowPixels)).toBe(true);
          if (depth?.ok !== true || shadowPixels?.ok !== true)
            throw new Error('Missing replay depth evidence');
          const depthValues = new DataView(
            depth.value.bytes.buffer,
            depth.value.bytes.byteOffset,
            depth.value.bytes.byteLength,
          );
          const reverse = JSON.stringify(color.pipeline.descriptor).includes('greater');
          expect(depth.value.provenance.selectedWorkIndex).toBe(color.workIndex);
          expect(shadowPixels.value.provenance.selectedWorkIndex).toBe(shadow.workIndex);
          let invalidDepthPixels = 0,
            depthCoverageMismatches = 0;
          index = 0;
          for (let y = 16; y < ALPHA_HASH_SIZE - 16; y++)
            for (let x = 16; x < ALPHA_HASH_SIZE - 16; x++) {
              const value = depthValues.getFloat32((y * ALPHA_HASH_SIZE + x) * 4, true);
              if (!Number.isFinite(value)) invalidDepthPixels++;
              if ((reverse ? value > 0 : value < 1) !== (live[index++] ?? 0) > 0)
                depthCoverageMismatches++;
            }
          expect(invalidDepthPixels, 'every color-depth texel is finite').toBe(0);
          expect(depthCoverageMismatches, 'every color-depth texel preserves coverage').toBe(0);
          const shadowAttachment = shadowPixels.value;
          expect(shadowAttachment.width).toBe(SHADOW_MAP_SIZE);
          expect(shadowAttachment.height).toBe(SHADOW_MAP_SIZE);
          if (shadowAttachment === undefined) throw new Error('Missing replay shadow attachment');
          const shadowEvidence = alphaShadowEvidence(
            shadowAttachment,
            JSON.stringify(shadow.pipeline.descriptor).includes('greater'),
          );
          writeFileSync(
            `${directory}/coverage-consistency.json`,
            JSON.stringify(
              {
                digest: encoded.digest,
                colorWork: color.workIndex,
                shadowWork: shadow?.workIndex,
                comparedColorDepthPixels: live.length,
                shadowCoverage: shadowEvidence.coverage,
                shadowDepthRange: shadowEvidence.depthRange,
                shadowBounds: shadowEvidence.bounds,
              },
              null,
              2,
            ),
          );
        } finally {
          submissions.restore();
          (await replay.dispose()).unwrap();
          device.nativeDevice().unwrap().destroy();
        }
      },
    });
    writeFileSync(`${directory}/metrics.json`, JSON.stringify(evidence, null, 2));
  } finally {
    (await host.renderer.dispose()).unwrap();
    (await recorder.dispose()).unwrap();
    texture?.destroy();
  }
});
