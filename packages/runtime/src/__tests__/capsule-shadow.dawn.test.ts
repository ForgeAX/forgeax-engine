import { mkdirSync, writeFileSync } from 'node:fs';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  type FrameModel,
  openReplay,
  summarizeFrame,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { deviceOptionsForAdapter } from '../../../render/src/assembly/device-feature-admission';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  assertCapsuleShadowEvidence,
  CAPSULE_DARKEN_EPSILON,
  CAPSULE_SHADOW_SIZE,
  type CapsuleShadowVariant,
  summarizeCapsuleShadowEvidence,
  verifyCapsuleShadow,
} from './capsule-shadow.fixture';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { deltaPng, luminancePng, offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
const directory = 'artifacts/capsule-shadow';
/** Packed tile header count lanes (see `CAPSULE_TILE_COUNT_BITS`). */
const TILE_COUNT_MASK = (1 << 6) - 1;
const TILE_SIZE = 16;

/** Depth-only raster works: the directional cascade (and any depth prepass) draws. */
function depthOnlyDraws(model: FrameModel): number {
  return model.works.filter(
    (work) =>
      work.attachments !== null &&
      work.attachments.colorViewHandleIds.length === 0 &&
      work.attachments.depthStencilViewHandleId !== null,
  ).length;
}

it('capsule shadows replace the skinned cascade shadow and bin every shadowed tile', {
  timeout: 240_000,
}, async () => {
  const size = CAPSULE_SHADOW_SIZE;
  const target = offscreenCanvas(size);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = await constructRuntimeRendererHost(
    target.canvas,
    { rhi: recorder.backend.rhi },
    { shaderManifestUrl: manifestUrl },
  );
  if (!host.ok) throw new Error(JSON.stringify(host.error));
  mkdirSync(directory, { recursive: true });
  const tapes = new Map<CapsuleShadowVariant, EncodedTape>();
  try {
    const evidence = await verifyCapsuleShadow(host.value.renderer, {
      recorder,
      capture(tape, variant) {
        tapes.set(variant, tape);
        writeFileSync(`${directory}/deferred-${variant}.rhitape`, tape.bytes);
      },
      image(name, observation) {
        const luminance = luminanceRgba16f(
          observation.bytes,
          size,
          size,
          observation.metadata.bytesPerRow,
        );
        writeFileSync(`${directory}/live-${name}.png`, luminancePng(luminance, size));
      },
    });
    const { none, raster, capsule } = evidence.deferred;
    writeFileSync(
      `${directory}/live-raster-delta.png`,
      deltaPng(none.luminance, raster.luminance, size),
    );
    writeFileSync(
      `${directory}/live-capsule-delta.png`,
      deltaPng(none.luminance, capsule.luminance, size),
    );
    const summary = summarizeCapsuleShadowEvidence(evidence);
    writeFileSync(`${directory}/evidence.json`, JSON.stringify(summary, null, 2));
    assertCapsuleShadowEvidence(evidence);

    const models = new Map(
      [...tapes].map(([variant, tape]) => [
        variant,
        buildFrameModel(decodeTape(tape.bytes).unwrap()),
      ]),
    );
    const rasterModel = models.get('raster');
    const capsuleModel = models.get('capsule');
    if (rasterModel === undefined || capsuleModel === undefined) throw new Error('missing tapes');
    // Declared storage inputs must be fully defined, including disabled or unused lanes.
    for (const [variant, model] of models) {
      const decoded = decodeTape((tapes.get(variant) as EncodedTape).bytes).unwrap();
      const lighting = model.works.find((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_standard_deferred'),
      );
      if (lighting === undefined) throw new Error('missing lighting');
      const bindings = lighting.bindings.filter(
        (entry) => entry.groupIndex === 1 && [13, 14].includes(entry.binding),
      );
      expect(bindings).toHaveLength(2);
      for (const binding of bindings) {
        const id = binding.resourceId;
        if (!model.unseededResources.some((resource) => resource.resourceId === id)) continue;
        const descriptor = decoded.bootstrap.find((resource) => resource.handleId === id)?.create;
        if (descriptor?.kind !== 'createBuffer')
          throw new Error('missing capsule buffer descriptor');
        const desc = descriptor.desc;
        if (
          typeof desc !== 'object' ||
          desc === null ||
          !('size' in desc) ||
          typeof desc.size !== 'number'
        )
          throw new Error('missing capsule buffer size');
        const capacity = desc.size;
        const ranges = decoded.events
          .slice(0, lighting.eventIndex)
          .flatMap((event) => {
            if (event.kind === 'writeBuffer' && event.handleId === id)
              return [[event.bufferOffset, event.bufferOffset + event.size] as const];
            if (event.kind === 'clearBuffer' && event.handleId === id) {
              const start = event.offset ?? 0;
              return [[start, start + (event.size ?? capacity - start)] as const];
            }
            return [];
          })
          .sort((a, b) => a[0] - b[0]);
        let end = 0;
        for (const [start, stop] of ranges) {
          expect(start, `uninitialized capsule buffer gap: ${id}`).toBeLessThanOrEqual(end);
          end = Math.max(end, stop);
        }
        expect(end, `uninitialized capsule buffer: ${id}`).toBeGreaterThanOrEqual(capacity);
      }
    }
    for (const [variant, model] of models)
      writeFileSync(
        `${directory}/deferred-${variant}-summary.json`,
        JSON.stringify(summarizeFrame(model), null, 2),
      );
    // The character leaves the cascades: exactly one fewer depth-only draw per cascade view.
    const rasterDepth = depthOnlyDraws(rasterModel);
    const capsuleDepth = depthOnlyDraws(capsuleModel);
    expect(capsuleDepth).toBeLessThan(rasterDepth);

    const lighting = capsuleModel.works.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_standard_deferred'),
    );
    expect(lighting).toHaveLength(1);
    const work = lighting[0];
    if (work === undefined) throw new Error('missing deferred lighting work');
    expect(work.pipeline.shaders.find((shader) => shader.stage === 'fragment')?.source).toContain(
      'directionalCapsuleShadow',
    );
    const tileBinding = work.bindings.find(
      (entry) => entry.groupIndex === 1 && entry.binding === 14,
    );
    if (tileBinding?.resourceId == null) throw new Error('missing capsule tile binding');

    const decoded = decodeTape((tapes.get('capsule') as EncodedTape).bytes).unwrap();
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice(deviceOptionsForAdapter(adapter))).unwrap();
    const replay = (
      await openReplay(decoded, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    let replayed: Float32Array;
    let headers: Uint32Array;
    try {
      const tiles = (
        await replay.readResourceAtWork(tileBinding.resourceId, work.workIndex)
      ).unwrap();
      const words = new Uint32Array(
        tiles.bytes.buffer.slice(
          tiles.bytes.byteOffset,
          tiles.bytes.byteOffset + tiles.bytes.byteLength,
        ),
      );
      const tilesX = Math.ceil(size / TILE_SIZE);
      headers = words.slice(0, tilesX * tilesX);
      const inspected = (await replay.inspectWork(work.workIndex, ['pixels'])).unwrap();
      const attachment = inspected.attachment;
      if (attachment === undefined) throw new Error('missing replay lighting output');
      replayed = luminanceRgba16f(attachment.bytes, size, size);
      writeFileSync(`${directory}/replay-capsule.png`, luminancePng(replayed, size));
    } finally {
      (await replay.dispose()).unwrap();
    }
    // The tile table is the only path from capsules to lighting: the
    // conservative bound must cover every shadowed pixel yet skip some tiles.
    const tilesX = Math.ceil(size / TILE_SIZE);
    const occupied = [...headers].filter((header) => (header & TILE_COUNT_MASK) > 0).length;
    expect(occupied).toBe(capsule.inspection?.tileCount);
    expect(occupied).toBeLessThan(headers.length);
    let uncovered = 0;
    for (let i = 0; i < size * size; i++) {
      if ((none.luminance[i] ?? 0) - (capsule.luminance[i] ?? 0) <= CAPSULE_DARKEN_EPSILON)
        continue;
      const tile = Math.floor(i / size / TILE_SIZE) * tilesX + Math.floor((i % size) / TILE_SIZE);
      if (((headers[tile] as number) & TILE_COUNT_MASK) === 0) uncovered++;
    }
    expect(uncovered).toBe(0);
    const [cx, cy] = evidence.capsuleShadow.centroid;
    const centroidTile =
      Math.floor((cy as number) / TILE_SIZE) * tilesX + Math.floor((cx as number) / TILE_SIZE);
    expect((headers[centroidTile] as number) & TILE_COUNT_MASK).toBe(1);
    // A fresh-device replay reproduces the capsule-shadowed lighting output.
    let maxReplayDelta = 0;
    for (let i = 0; i < size * size; i++)
      maxReplayDelta = Math.max(
        maxReplayDelta,
        Math.abs((replayed[i] ?? 0) - (capsule.luminance[i] ?? 0)),
      );
    writeFileSync(
      `${directory}/evidence.json`,
      JSON.stringify(
        {
          backend: 'dawn',
          size,
          ...summary,
          rhiDebug: {
            depthOnlyDraws: { raster: rasterDepth, capsule: capsuleDepth },
            occupiedTiles: occupied,
            tileCounts: Array.from(headers, (header) => header & TILE_COUNT_MASK),
            totalTiles: headers.length,
            maxReplayDelta,
            tapes: Object.fromEntries([...tapes].map(([variant, tape]) => [variant, tape.digest])),
          },
        },
        null,
        2,
      ),
    );
    expect(maxReplayDelta).toBeLessThan(0.05);
  } finally {
    host.value.renderer.dispose();
    target.destroy();
    (await recorder.dispose()).unwrap();
  }
});
