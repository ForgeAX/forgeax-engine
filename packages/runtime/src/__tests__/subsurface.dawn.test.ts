import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
  tapeDigest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { FOLIAGE_MATERIAL_PACKAGES } from '../../../../apps/hello/foliage-transmission/src/material-contract';
import { constructRuntimeRendererHost } from '../renderer-host';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';
import { verifySubsurface } from './subsurface.fixture';

const manifest = shaderManifestUrl(
  await buildEngineShaderManifest({
    materialPackages: FOLIAGE_MATERIAL_PACKAGES.map((file) =>
      resolve(process.cwd(), 'apps/hello/foliage-transmission/src', file),
    ),
  }),
);
it.each([
  'rigid',
  'instanced',
  'skin',
] as const)('ordinary %s SSS preserves emission and restores zero on Dawn', async (kind) => {
  let surface: GPUTexture | undefined;
  const canvas = {
    width: 128,
    height: 128,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        surface = options.device.createTexture({
          size: [128, 128],
          format: options.format,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          usage: 0x11,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => surface,
    }),
  };
  const captureDirectory = process.env.FORGEAX_ROI25_CAPTURE_DIR;
  const recorder = captureDirectory === undefined ? undefined : renderValue(attachRecorder(webgpu));
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      recorder === undefined ? undefined : { rhi: recorder.backend.rhi },
      { shaderManifestUrl: manifest },
    ),
  );
  try {
    await verifySubsurface(
      host.renderer,
      kind,
      recorder === undefined || captureDirectory === undefined
        ? undefined
        : async (draw, inspect) => {
            const pending = recorder.captureFrame({ byteBudget: 268_435_456 });
            renderValue(await recorder.frameBoundary());
            await draw();
            renderValue(await recorder.frameBoundary());
            const encoded = renderValue(await pending);
            const tape = renderValue(decodeTape(encoded.bytes));
            const model = buildFrameModel(tape);
            mkdirSync(captureDirectory, { recursive: true });
            const captureDigest = tapeDigest(encoded.bytes);
            const prefix = join(
              captureDirectory,
              `dawn-sss-active-${captureDigest.slice('sha256:'.length, 24)}`,
            );
            writeFileSync(`${prefix}.rhitape`, encoded.bytes);
            const rendererInspection = inspect();
            writeFileSync(
              `${prefix}-renderer-inspection.json`,
              JSON.stringify(
                {
                  frame: rendererInspection.frame,
                  profile: rendererInspection.profile,
                  views: rendererInspection.views,
                  frustumStats: rendererInspection.frustumStats,
                  renderScene: rendererInspection.renderScene,
                  perFramePassNames: rendererInspection.perFramePassNames,
                  meshMaterialBindings: rendererInspection.meshMaterialBindings,
                  transmission: rendererInspection.transmission,
                },
                null,
                2,
              ),
            );
            writeFileSync(
              `${prefix}-works.json`,
              JSON.stringify(
                model.works.map((candidate) => ({
                  workIndex: candidate.workIndex,
                  eventIndex: candidate.eventIndex,
                  passIndex: candidate.passIndex,
                  drawCall: candidate.drawCall,
                  shaders: candidate.pipeline.shaders.map((shader) => ({
                    stage: shader.stage,
                    entryPoint: shader.entryPoint,
                    moduleHandleId: shader.moduleHandleId,
                    source: shader.source,
                  })),
                  descriptor: candidate.pipeline.descriptor,
                  attachments: candidate.attachments,
                  bindings: candidate.bindings,
                })),
                null,
                2,
              ),
            );
            const work = model.works.find((candidate) =>
              candidate.pipeline.shaders.some((shader) => shader.entryPoint === 'cs_subsurface'),
            );
            if (work === undefined) {
              throw new Error(`captured SSS frame has no cs_subsurface work: ${prefix}`);
            }
            const adapter = renderValue(await webgpu.rhi.requestAdapter());
            const replayDevice = renderValue(
              await adapter.requestDevice(
                replayDeviceRequest(tape, adapter.features, adapter.limits),
              ),
            );
            const rawDevice = webgpu._internal_getRawDevice(replayDevice);
            if (rawDevice === undefined) throw new Error('fresh Dawn replay device unavailable');
            const replay = renderValue(
              await openReplay(tape, {
                device: replayDevice,
                createShaderModule: webgpu.createShaderModule,
              }),
            );
            const readbacks: unknown[] = [];
            try {
              const inspection = renderValue(
                await replay.inspectWork(work.workIndex, [
                  'pipeline',
                  'bindings',
                  'pixels',
                  'outputs',
                ]),
              );
              if (inspection.attachment === undefined)
                throw new Error('fresh replay did not read back the selected SSS compute output');
              writeFileSync(
                `${prefix}-work-${work.workIndex}-pixels.${inspection.attachment.format}.bin`,
                inspection.attachment.bytes,
              );
              for (const output of inspection.outputs ?? []) {
                if (!output.result.ok) {
                  readbacks.push({
                    name: output.name,
                    resourceId: output.resourceId,
                    error: output.result.error,
                  });
                  continue;
                }
                writeFileSync(
                  `${prefix}-output-${output.name.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}.${output.result.value.format}.bin`,
                  output.result.value.bytes,
                );
                readbacks.push({
                  name: output.name,
                  resourceId: output.resourceId,
                  format: output.result.value.format,
                  bytes: output.result.value.bytes.byteLength,
                  provenance: output.result.value.provenance,
                });
              }
              const { attachment, ...inspectionDetails } = inspection;
              writeFileSync(
                `${prefix}-model.json`,
                JSON.stringify(
                  {
                    head: process.env.FORGEAX_SOURCE_HEAD ?? 'unknown',
                    worktreeDiffSha256: process.env.FORGEAX_WORKTREE_DIFF_SHA256 ?? 'unknown',
                    tapeDigest: captureDigest,
                    passes: model.passes,
                    workIndex: work.workIndex,
                    eventIndex: work.eventIndex,
                    unseededResources: model.unseededResources,
                    selectedWork: work,
                    works: model.works.map((candidate) => ({
                      workIndex: candidate.workIndex,
                      eventIndex: candidate.eventIndex,
                      passIndex: candidate.passIndex,
                      drawCall: candidate.drawCall,
                      shaders: candidate.pipeline.shaders.map((shader) => ({
                        stage: shader.stage,
                        entryPoint: shader.entryPoint,
                        moduleHandleId: shader.moduleHandleId,
                        source: shader.source,
                      })),
                      descriptor: candidate.pipeline.descriptor,
                      attachments: candidate.attachments,
                      bindings: candidate.bindings,
                    })),
                    resources: model.resources.filter((resource) =>
                      new Set(work.bindings.map((binding) => binding.resourceId)).has(
                        resource.resourceId,
                      ),
                    ),
                    bindings: inspection.bindings,
                    inspection: {
                      ...inspectionDetails,
                      attachment: {
                        format: attachment.format,
                        resourceId: attachment.resourceId,
                        byteLength: attachment.bytes.byteLength,
                        provenance: attachment.provenance,
                      },
                    },
                    readbacks,
                    replayDevice: {
                      features: [...replayDevice.features],
                      limits: replayDevice.limits,
                    },
                  },
                  null,
                  2,
                ),
              );
              // biome-ignore lint/suspicious/noConsole: keep one durable pointer to the exact RHI capture
              console.log(
                '[roi25-rhi-capture]',
                JSON.stringify({
                  path: prefix,
                  digest: captureDigest,
                  workIndex: work.workIndex,
                  shader: work.pipeline.shaders.find(
                    (shader) => shader.entryPoint === 'cs_subsurface',
                  )?.entryPoint,
                  readbacks,
                }),
              );
            } finally {
              renderValue(await replay.dispose());
              rawDevice.destroy();
            }
          },
      // One numerical owner retains the 25-tap quality path. Ordinary geometry
      // and Worker publication use the shared 13-tap profile.
      kind === 'rigid' ? 'high' : undefined,
    );
  } finally {
    await host.renderer.dispose();
    surface?.destroy();
    if (recorder !== undefined) renderValue(await recorder.dispose());
  }
}, 180_000);
