import { mkdirSync, writeFileSync } from 'node:fs';
import {
  attachRecorder,
  buildFrameModel,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { verifyStandardDeferredParity } from './standard-deferred-parity.fixture';

const manifest = await buildEngineShaderManifest();
const manifestUrl = shaderManifestUrl(manifest);

it.each([
  { skinned: false, visibleSurface: false },
  { skinned: true, visibleSurface: false },
  { skinned: true, visibleSurface: true },
])('resolves Standard lighting from G-buffer with Forward pixel parity on Dawn (skin=$skinned, visible=$visibleSurface)', {
  timeout: 120_000,
}, async ({ skinned, visibleSurface }) => {
  let texture: GPUTexture | undefined;
  let visibleTemporalAttachment = false;
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      configure: (options: GPUCanvasConfiguration) => {
        visibleTemporalAttachment =
          options.device.limits.maxColorAttachments >= 8 &&
          options.device.limits.maxColorAttachmentBytesPerSample >= 56;
        texture?.destroy();
        texture = options.device.createTexture({
          size: [64, 64],
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
  const host = await constructRuntimeRendererHost(
    canvas,
    { rhi: recorder.backend.rhi },
    { shaderManifestUrl: manifestUrl },
  );
  expect(host.ok, JSON.stringify(host.ok ? {} : host.error)).toBe(true);
  if (!host.ok) throw host.error;
  try {
    const evidence = await verifyStandardDeferredParity(host.value.renderer, {
      skinned,
      visibleSurface,
      recorder,
      image(name, bytes, bytesPerRow) {
        const directory = `artifacts/standard-deferred/${visibleSurface ? 'skin-visible' : skinned ? 'skin' : 'rigid'}`;
        mkdirSync(directory, { recursive: true });
        writeFileSync(`${directory}/${name}.rgba16f`, bytes);
        writeFileSync(
          `${directory}/${name}.json`,
          JSON.stringify({ width: 64, height: 64, bytesPerRow }),
        );
      },
      async capture(tape, path) {
        const model = buildFrameModel(tape.tape);
        const lighting = model.works.filter((work) =>
          work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_standard_deferred'),
        );
        const geometry = model.works.filter((work) =>
          work.pipeline.shaders.some(
            (shader) =>
              shader.entryPoint === 'fs_gbuffer' || shader.entryPoint === 'fs_gbuffer_uncovered',
          ),
        );
        if (path === 'deferred') {
          // Early G-buffer draws last frame's visible set; `g-buffer-late`
          // appends instances the HZB test newly finds visible.
          expect(geometry).toHaveLength(visibleSurface ? 4 : 2);
          const lateGeometry = geometry.find((work) => work.passIndex !== geometry[0]?.passIndex);
          expect(lateGeometry).toBeDefined();
          expect(lateGeometry?.attachments?.colorViewHandleIds).toEqual(
            geometry[0]?.attachments?.colorViewHandleIds,
          );
          // The geometry and lighting passes target the same SceneColor.
          // Emissive has no separate texture or lighting sampler anymore.
          expect(geometry[0]?.attachments?.colorViewHandleIds[0]).toBe(
            lighting[0]?.attachments?.colorViewHandleIds[0],
          );
          expect(geometry[0]?.pipeline.descriptor).toMatchObject({
            desc: {
              fragment: {
                targets: [
                  { format: 'rgba16float' },
                  { format: 'r32uint' },
                  { format: 'r32uint' },
                  { format: 'r32uint' },
                  { format: 'r32uint' },
                  { format: 'rg32uint' },
                  ...(visibleSurface ? [{ format: 'rgba32uint' }] : []),
                  ...(visibleSurface && visibleTemporalAttachment
                    ? [{ format: 'rgba16float' }]
                    : []),
                ],
              },
            },
          });
          expect(lighting[0]?.pipeline.descriptor).toMatchObject({
            desc: {
              fragment: {
                targets: [
                  {
                    blend: {
                      color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
                      alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
                    },
                  },
                ],
              },
            },
          });
          expect(
            model.resources.some((resource) =>
              JSON.stringify(resource).includes('gbuffer-emissive-opacity'),
            ),
          ).toBe(false);
          for (const work of geometry)
            expect(work.drawCall).toMatchObject({ kind: 'drawIndexedIndirect' });
          if (visibleSurface) {
            const skinWorks = geometry.filter((work) =>
              work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_gbuffer_uncovered'),
            );
            expect(skinWorks).toHaveLength(2);
            for (const work of skinWorks) {
              expect(work.drawCall).toMatchObject({ kind: 'drawIndexedIndirect' });
              expect(work.pipeline.descriptor).toMatchObject({
                desc: {
                  fragment: {
                    entryPoint: 'fs_gbuffer_uncovered',
                    targets: [
                      { format: 'rgba16float' },
                      { format: 'r32uint' },
                      { format: 'r32uint' },
                      { format: 'r32uint' },
                      { format: 'r32uint' },
                      { format: 'rg32uint' },
                      { format: 'rgba32uint' },
                      ...(visibleTemporalAttachment ? [{ format: 'rgba16float' }] : []),
                    ],
                  },
                },
              });
            }
            const last = geometry.at(-1);
            const identity = last?.attachments?.colorViewHandleIds[6];
            const receiver = last?.attachments?.colorViewHandleIds[5];
            if (last === undefined || identity === undefined || receiver === undefined)
              throw new Error('missing mixed visible-surface attachments');
            const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
            const device = (
              await adapter.requestDevice(
                replayDeviceRequest(tape.tape, adapter.features, adapter.limits),
              )
            ).unwrap();
            const gpuErrors: string[] = [];
            const native = webgpu._internal_getRawDevice(device);
            native?.addEventListener('uncapturederror', (event) =>
              gpuErrors.push(event.error.message),
            );
            const replay = (
              await openReplay(tape.tape, { device, createShaderModule: webgpu.createShaderModule })
            ).unwrap();
            try {
              const rows = (await replay.readResourceAtWork(identity, last.workIndex)).unwrap()
                .bytes;
              const normals = (await replay.readResourceAtWork(receiver, last.workIndex)).unwrap()
                .bytes;
              const ids = new Uint32Array(rows.buffer, rows.byteOffset, rows.byteLength / 4);
              const ng = new Uint32Array(
                normals.buffer,
                normals.byteOffset,
                normals.byteLength / 4,
              );
              expect(Array.from(ids.slice((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4))).toEqual([
                0, 0, 0, 0,
              ]);
              expect(ids.some((value, index) => index % 4 === 0 && value > 0)).toBe(true);
              expect(ng[(32 * 64 + 32) * 2]).toBeGreaterThan(0);
              expect(ng[(32 * 64 + 32) * 2 + 1]).toBe(0xffffffff);
              expect(gpuErrors).toEqual([]);
              const directory = 'artifacts/standard-deferred/skin-visible';
              mkdirSync(directory, { recursive: true });
              writeFileSync(`${directory}/identity.rgba32uint`, rows);
              writeFileSync(`${directory}/receiver.rg32uint`, normals);
            } finally {
              (await replay.dispose()).unwrap();
              native?.destroy();
            }
          }
          expect(lighting).toHaveLength(1);
          expect(lighting[0]?.vertexBuffers).toEqual([]);
          expect(lighting[0]?.indexBuffer).toBeNull();
          expect(lighting[0]?.attachments?.depthStencilViewHandleId).toBeNull();
          expect(lighting[0]?.drawCall).toMatchObject({ kind: 'draw', vertexCount: 3 });
          expect(
            model.works.filter(
              (work) =>
                work.pipeline.shaders.some(
                  (shader) => shader.entryPoint === 'fs_main' || shader.entryPoint === 'fs_opaque',
                ) &&
                (work.vertexBuffers.length > 0 || work.indexBuffer !== null),
            ),
          ).toHaveLength(0);
        } else {
          expect(lighting).toHaveLength(0);
          expect(geometry).toHaveLength(0);
        }
        const directory = `artifacts/standard-deferred/${path}`;
        mkdirSync(directory, { recursive: true });
        for (const work of model.works) {
          for (const shader of work.pipeline.shaders) {
            if (shader.source !== null && shader.stage === 'fragment')
              writeFileSync(
                `${directory}/${visibleSurface ? 'skin-visible' : skinned ? 'skin' : 'rigid'}-${work.workIndex}-${shader.entryPoint}.wgsl`,
                shader.source,
              );
          }
        }
        writeFileSync(
          `${directory}/${visibleSurface ? 'skin-visible' : skinned ? 'skin' : 'rigid'}.rhitape`,
          tape.bytes,
        );
        writeFileSync(
          `${directory}/${visibleSurface ? 'skin-visible' : skinned ? 'skin' : 'rigid'}-topology.json`,
          JSON.stringify(
            {
              digest: tape.digest,
              works: model.works.map((work) => ({
                draw: work.drawCall,
                shaders: work.pipeline.shaders.map((shader) => ({
                  stage: shader.stage,
                  entry: shader.entryPoint,
                })),
              })),
            },
            null,
            2,
          ),
        );
      },
    });
    writeFileSync(
      `artifacts/standard-deferred/${visibleSurface ? 'skin-visible' : skinned ? 'skin' : 'rigid'}-parity.json`,
      JSON.stringify({ backend: 'dawn', skinned, evidence }, null, 2),
    );
  } finally {
    host.value.renderer.dispose();
    texture?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
