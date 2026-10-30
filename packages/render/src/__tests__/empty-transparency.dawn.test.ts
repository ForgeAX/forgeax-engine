import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { createOitScene, OIT_SIZE } from '../../../runtime/src/__tests__/oit.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { constructRuntimeRendererHost } from '../../../runtime/src/renderer-host';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());

it.each([
  { renderPath: 'forward', msaa: false },
  { renderPath: 'forward', msaa: true },
  { renderPath: 'deferred', msaa: false },
] as const)('empty transparency $renderPath msaa=$msaa preserves pixels through membership changes', {
  timeout: 180_000,
}, async (options) => {
  let texture: GPUTexture | undefined;
  const canvas = {
    width: OIT_SIZE,
    height: OIT_SIZE,
    getContext: () => ({
      configure: (config: GPUCanvasConfiguration) => {
        texture?.destroy();
        texture = config.device.createTexture({
          size: [OIT_SIZE, OIT_SIZE],
          format: config.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
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
  const scene = await createOitScene(host.renderer, options);
  try {
    scene.setTransparency('sorted');
    const evidence: unknown[] = [];
    const sample = async (transparent: boolean) => {
      scene.spawnLayers(transparent ? [0] : []);
      await scene.sample();
      await scene.sample();
      return scene.sample({
        recorder,
        async onTape(encoded) {
          const tape = decodeTape(encoded.bytes).unwrap();
          const model = buildFrameModel(tape);
          const passes = model.passes.map((pass) => {
            const event = tape.events[pass.beginEventIndex];
            return {
              label: event?.kind === 'beginRenderPass' ? event.desc.label : undefined,
              works: pass.workIndices.length,
              resolves: pass.colorAttachmentResolveViewHandleIds,
            };
          });
          const selected = passes.filter((pass) => pass.label === 'transparent');
          expect(selected).toHaveLength(transparent || options.msaa ? 1 : 0);
          if (transparent) expect(selected[0]?.works).toBeGreaterThan(0);
          else if (options.msaa) {
            expect(selected[0]?.works).toBe(0);
            expect(selected[0]?.resolves.some((view) => view !== null)).toBe(true);
          }
          evidence.push({ transparent, digest: encoded.digest, passes });
        },
      });
    };
    const before = await sample(false);
    const blended = await sample(true);
    const restored = await sample(false);
    for (const color of Object.values(before.probes))
      expect(color.every(Number.isFinite)).toBe(true);
    // The background/occluder survive; the selected red layer is a falsifier
    // against blanket pass suppression, and removal must restore exact pixels.
    expect(before.probes.background).toEqual([0.25, 0.25, 0.25]);
    expect(blended.probes.left[0]).toBeGreaterThan(before.probes.left[0] + 0.1);
    expect(blended.probes.background).toEqual(before.probes.background);
    expect(blended.probes.occluded).toEqual(before.probes.occluded);
    expect(equalBytes(restored.observation.bytes, before.observation.bytes)).toBe(true);
    expect(scene.errors).toEqual([]);
    const directory = 'artifacts/empty-transparency';
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      `${directory}/${options.renderPath}-msaa${options.msaa ? 4 : 1}.json`,
      JSON.stringify({ kind: 'empty-transparent-pass', ...options, evidence }, null, 2),
    );
  } finally {
    scene.dispose();
    host.renderer.dispose();
    (await recorder.dispose()).unwrap();
    texture?.destroy();
  }
});
