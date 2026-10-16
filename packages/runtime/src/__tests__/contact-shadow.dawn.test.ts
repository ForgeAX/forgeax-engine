import { mkdirSync, writeFileSync } from 'node:fs';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  openReplay,
  summarizeFrame,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { deviceOptionsForAdapter } from '../../../render/src/assembly/device-feature-admission';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  assertContactShadowEvidence,
  CONTACT_DARKEN_EPSILON,
  CONTACT_SHADOW_SIZE,
  luminanceRgba16f,
  verifyContactShadow,
} from './contact-shadow.fixture';
import { deltaPng, luminancePng, offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
const directory = 'artifacts/contact-shadow';

function writeLuminancePng(name: string, luminance: Float32Array, size: number) {
  writeFileSync(`${directory}/${name}.png`, luminancePng(luminance, size));
}

function writeDeltaPng(name: string, off: Float32Array, on: Float32Array, size: number) {
  writeFileSync(`${directory}/${name}.png`, deltaPng(off, on, size));
}

it('contact shadows darken only the anti-light contact band and replay from RHI Debug', {
  timeout: 180_000,
}, async () => {
  const size = CONTACT_SHADOW_SIZE;
  const target = offscreenCanvas(size);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = await constructRuntimeRendererHost(
    target.canvas,
    { rhi: recorder.backend.rhi },
    { shaderManifestUrl: manifestUrl },
  );
  if (!host.ok) throw new Error(JSON.stringify(host.error));
  mkdirSync(directory, { recursive: true });
  const tapes = new Map<'off' | 'on', EncodedTape>();
  try {
    const evidence = await verifyContactShadow(host.value.renderer, {
      recorder,
      capture(tape, label) {
        tapes.set(label, tape);
        writeFileSync(`${directory}/deferred-${label}.rhitape`, tape.bytes);
      },
      image(name, observation) {
        writeLuminancePng(
          `live-${name}`,
          luminanceRgba16f(observation.bytes, size, size, observation.metadata.bytesPerRow),
          size,
        );
      },
    });
    writeDeltaPng('live-deferred-delta', evidence.deferredOff, evidence.deferredOn, size);
    assertContactShadowEvidence(evidence);

    // RHI Debug: the feature is inline, so the frame topology must not change
    // and the single lighting pipeline must carry the contact march.
    const models = new Map(
      [...tapes].map(([label, tape]) => [label, buildFrameModel(decodeTape(tape.bytes).unwrap())]),
    );
    const topology = (label: 'off' | 'on') => {
      const model = models.get(label);
      if (model === undefined) throw new Error(`missing ${label} capture`);
      return model.works.map((work) => ({
        draw: work.drawCall.kind,
        shaders: work.pipeline.shaders.map((shader) => shader.entryPoint),
      }));
    };
    expect(topology('on')).toEqual(topology('off'));
    const replayed: Record<string, Float32Array> = {};
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice(deviceOptionsForAdapter(adapter))).unwrap();
    for (const [label, tape] of tapes) {
      const decoded = decodeTape(tape.bytes).unwrap();
      const model = buildFrameModel(decoded);
      writeFileSync(
        `${directory}/deferred-${label}-summary.json`,
        JSON.stringify({ digest: tape.digest, ...summarizeFrame(model) }, null, 2),
      );
      const lighting = model.works.filter((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_standard_deferred'),
      );
      expect(lighting).toHaveLength(1);
      const work = lighting[0];
      if (work === undefined) throw new Error('missing deferred lighting work');
      const source = work.pipeline.shaders.find((shader) => shader.stage === 'fragment')?.source;
      expect(source).toContain('directionalContactShadow');
      writeFileSync(`${directory}/lighting-${label}.wgsl`, source ?? '');
      const replay = (
        await openReplay(decoded, { device, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      try {
        const inspected = (await replay.inspectWork(work.workIndex, ['pixels'])).unwrap();
        const attachment = inspected.attachment;
        expect(attachment?.format).toBe('rgba16float');
        if (attachment === undefined) throw new Error('missing replay lighting output');
        replayed[label] = luminanceRgba16f(attachment.bytes, size, size);
        writeLuminancePng(`replay-deferred-${label}`, replayed[label], size);
      } finally {
        (await replay.dispose()).unwrap();
      }
    }
    const replayOn = replayed.on;
    const replayOff = replayed.off;
    if (replayOn === undefined || replayOff === undefined) throw new Error('missing replay images');
    writeDeltaPng('replay-deferred-delta', replayOff, replayOn, size);
    // The fresh-device replay must reproduce the same contact-shadow mask.
    let liveMask = 0;
    let agreeing = 0;
    for (let i = 0; i < size * size; i++) {
      const live = (evidence.deferredOff[i] ?? 0) - (evidence.deferredOn[i] ?? 0);
      const replay = (replayOff[i] ?? 0) - (replayOn[i] ?? 0);
      if (live <= CONTACT_DARKEN_EPSILON) continue;
      liveMask++;
      if (replay > CONTACT_DARKEN_EPSILON * 0.5) agreeing++;
    }
    expect(agreeing / liveMask).toBeGreaterThan(0.95);
    writeFileSync(
      `${directory}/evidence.json`,
      JSON.stringify(
        {
          backend: 'dawn',
          size,
          darkenedPixels: evidence.darkenedPixels,
          darkenedCentroid: evidence.darkenedCentroid,
          darkenedOnLightSide: evidence.darkenedOnLightSide,
          maxDarken: evidence.maxDarken,
          maxBrighten: evidence.maxBrighten,
          farFieldMaxDelta: evidence.farFieldMaxDelta,
          forwardMaxDelta: evidence.forwardMaxDelta,
          replayMaskAgreement: agreeing / liveMask,
          tapes: Object.fromEntries([...tapes].map(([label, tape]) => [label, tape.digest])),
          worksPerFrame: topology('on').length,
        },
        null,
        2,
      ),
    );
  } finally {
    host.value.renderer.dispose();
    target.destroy();
    (await recorder.dispose()).unwrap();
  }
});
