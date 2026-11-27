import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type V7Tape,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { shaderPublicationUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const GBUFFER_RGB_TOLERANCE = 1 / 128;

function compareRgba16Float(
  candidate: Uint8Array,
  reference: Uint8Array,
  metadata: { readonly width: number; readonly height: number; readonly bytesPerRow: number },
) {
  const candidateView = new DataView(candidate.buffer, candidate.byteOffset, candidate.byteLength);
  const referenceView = new DataView(reference.buffer, reference.byteOffset, reference.byteLength);
  const offsets: number[] = [];
  let differingBytes = 0;
  let alphaMismatches = 0;
  let maximumRgbDifference = 0;
  for (let y = 0; y < metadata.height; y++) {
    for (let x = 0; x < metadata.width; x++) {
      for (let channel = 0; channel < 4; channel++) {
        const offset = y * metadata.bytesPerRow + (x * 4 + channel) * 2;
        const candidateBits = candidateView.getUint16(offset, true);
        const referenceBits = referenceView.getUint16(offset, true);
        for (let byte = 0; byte < 2; byte++) {
          if (candidate[offset + byte] === reference[offset + byte]) continue;
          differingBytes++;
          if (offsets.length < 32) offsets.push(offset + byte);
        }
        if (channel === 3) {
          if (candidateBits !== referenceBits) alphaMismatches++;
          continue;
        }
        maximumRgbDifference = Math.max(
          maximumRgbDifference,
          Math.abs(halfFloat.f16ToF32(candidateBits) - halfFloat.f16ToF32(referenceBits)),
        );
      }
    }
  }
  return {
    withinTolerance:
      candidate.byteLength === reference.byteLength &&
      alphaMismatches === 0 &&
      maximumRgbDifference <= GBUFFER_RGB_TOLERANCE,
    differingBytes,
    alphaMismatches,
    maximumRgbDifference,
    firstDifferingByteOffsets: offsets,
  };
}

it('binds only the stock Surface textures in both Deferred GBuffer formats and draw lanes', async () => {
  const target = offscreenCanvas(64);
  const recorder = attachRecorder(webgpu).unwrap();
  const { renderer, assets, initialization } = renderValue(
    await constructRuntimeRendererHost(
      target.canvas,
      { rhi: recorder.backend.rhi },
      {
        shaderManifestUrl: shaderPublicationUrl(
          await buildEngineShaderTemplateManifest({ hdrpSsao: false }),
        ),
      },
    ),
  );
  try {
    renderValue(await initialization);
    const world = new World({ assets });
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: { projection: 1, left: -2, right: 2, bottom: -2, top: 2, antialias: 0, bloom: 0 },
        },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, 0, -1], intensity: 3, castShadow: false },
      })
      .unwrap();
    const texture = (bytes: number[]) =>
      assets
        .create({
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: bytes.length / 4, height: 1 } },
          format: 'rgba8unorm',
          colorSpace: 'linear',
          mips: { kind: 'none' },
          data: new Uint8Array(bytes),
        } satisfies TextureAsset)
        .unwrap();
    const baseColor = { texture: texture([180, 96, 48, 0, 180, 96, 48, 255]) };
    const orm = { texture: texture([210, 130, 60, 255]) };
    const materials = [
      Materials.standard({ baseColor: [0.3, 0.5, 0.8, 1] }),
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        baseColorTexture: baseColor,
        alphaCutoff: 0.5,
      }),
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        baseColorTexture: baseColor,
        normalTexture: { texture: texture([128, 128, 255, 255]) },
        metallicRoughnessTexture: orm,
        occlusionTexture: orm,
      }),
    ];
    const mesh = assets.create(createBoxGeometry(1, 1.5, 0.1).unwrap()).unwrap();
    for (const [index, material] of materials.entries())
      world
        .spawn(
          { component: Transform, data: { pos: [(index - 1) * 1.25, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [assets.create(material).unwrap()] } },
        )
        .unwrap();
    const source = renderer.attach(world).unwrap();
    for (const compact of [false, true]) {
      renderValue(
        renderer.setProfile({
          ...DEFAULT_STANDARD_PROFILE,
          renderPath: 'deferred',
          ...(compact ? { gbufferFormat: 'default' } : {}),
          ambientOcclusion: { enabled: false },
        }),
      );
      let reference:
        | {
            bytes: Uint8Array;
            tape: Uint8Array;
            metadata: {
              readonly bytesPerRow: number;
              readonly width: number;
              readonly height: number;
            };
          }
        | undefined;
      for (const direct of [true, false]) {
        const draw = (observe = false) => {
          world.update(1 / 60).unwrap();
          propagateTransforms(world).unwrap();
          return drawReadyFrame(
            renderer,
            { source, ...(direct ? { geometryLane: 'direct' as const } : {}) },
            observe ? ['linear-hdr'] : undefined,
          );
        };
        await draw();
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const frame = await draw(true);
        (await recorder.frameBoundary()).unwrap();
        const capture = (await pending).unwrap();
        const tape = decodeTape(capture.bytes).unwrap();
        expectNoUnusedBuffers(tape);
        const model = buildFrameModel(tape);
        const lighting = model.works.find((work) =>
          work.pipeline.shaders.some((shader) =>
            shader.entryPoint?.startsWith('fs_standard_deferred'),
          ),
        );
        expect(lighting).toBeDefined();
        expect(
          lighting?.bindings.filter(
            ({ groupIndex, binding }) => groupIndex === 1 && [5, 10, 13, 14].includes(binding),
          ),
        ).toEqual([]);
        const entry = compact ? 'fs_gbuffer_compact' : 'fs_gbuffer';
        const geometry = model.works.filter((work) =>
          work.pipeline.shaders.some((shader) => shader.entryPoint === entry),
        );
        for (const work of geometry) {
          expect(
            work.bindings
              .filter((binding) => binding.groupIndex === 0)
              .map((binding) => binding.binding),
          ).toEqual([0]);
          expect(
            work.bindings
              .filter((binding) => binding.groupIndex === 3 && binding.binding !== 1)
              .map((binding) => binding.binding),
          ).toEqual(direct ? [0] : [0, 2, 6, 8, 9]);
        }
        const textureCounts = new Set(
          geometry.map((work) => {
            expect(work.drawCall).toMatchObject({
              kind: direct ? 'drawIndexed' : 'drawIndexedIndirect',
            });
            return work.bindings.filter(
              (binding) => binding.groupIndex === 1 && binding.resourceKind === 'textureView',
            ).length;
          }),
        );
        expect([...textureCounts].sort()).toEqual([0, 1, 3]);
        const observation = renderValue(
          await renderer.observe(frame, { include: ['linear-hdr'] }),
        ).observations?.find((item) => item.domain === 'linear-hdr');
        if (observation === undefined) throw new Error('missing GBuffer lighting observation');
        const { bytes, metadata } = observation;
        // The two sides of the center box differ in Base Color alpha.
        const pixels = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const red = (x: number) => pixels.getUint16(32 * metadata.bytesPerRow + x * 8, true);
        expect(Math.min(red(27), red(37))).toBe(0);
        expect(Math.max(red(27), red(37))).toBeGreaterThan(0);
        if (reference === undefined) {
          reference = { bytes: bytes.slice(), tape: capture.bytes.slice(), metadata };
          continue;
        }
        const directory = process.env.FORGEAX_SURFACE_GBUFFER_BINDINGS_EVIDENCE_DIR;
        saveGBufferTapes(directory, compact, reference.tape, capture.bytes);
        const comparison = compareRgba16Float(bytes, reference.bytes, metadata);
        if (!comparison.withinTolerance) {
          const evidence = {
            format: compact ? 'compact' : 'full',
            referenceLane: 'direct',
            candidateLane: direct ? 'direct' : 'gpu-driven',
            referenceLength: reference.bytes.length,
            candidateLength: bytes.length,
            referenceMetadata: reference.metadata,
            candidateMetadata: metadata,
            rgbTolerance: GBUFFER_RGB_TOLERANCE,
            ...comparison,
          };
          if (directory !== undefined && directory.length > 0) {
            mkdirSync(directory, { recursive: true });
            const prefix = compact ? 'compact' : 'full';
            writeFileSync(join(directory, `${prefix}-direct.rgba16float`), reference.bytes);
            writeFileSync(join(directory, `${prefix}-gpu-driven.rgba16float`), bytes);
            writeFileSync(
              join(directory, `${prefix}-comparison.json`),
              `${JSON.stringify(evidence, null, 2)}\n`,
            );
          }
          expect(
            comparison.withinTolerance,
            `Deferred GBuffer lane pixel mismatch: ${JSON.stringify(evidence)}`,
          ).toBe(true);
        }
      }
    }
  } finally {
    renderValue(await renderer.dispose());
    assets.dispose();
    target.destroy();
    (await recorder.dispose()).unwrap();
  }
}, 120_000);

function expectNoUnusedBuffers(tape: V7Tape): void {
  const unneeded = new Set([
    'points-lines-view-ubo',
    'surface-dynamic-input-page',
    'surface-dynamic-frame-input',
    'surface-dynamic-shared-frame-input',
  ]);
  for (const resource of tape.bootstrap) {
    if (resource.kind !== 'buffer') continue;
    const desc = resource.create.desc as { readonly label?: string };
    expect(unneeded.has(desc.label ?? ''), desc.label).toBe(false);
  }
  for (const event of tape.events) {
    if (event.kind !== 'createBuffer') continue;
    const { label } = event.desc as { readonly label?: string };
    expect(unneeded.has(label ?? ''), label).toBe(false);
  }
}

function saveGBufferTapes(
  directory: string | undefined,
  compact: boolean,
  direct: Uint8Array,
  indirect: Uint8Array,
): void {
  if (directory === undefined || directory.length === 0) return;
  mkdirSync(directory, { recursive: true });
  const prefix = compact ? 'compact' : 'full';
  writeFileSync(join(directory, `${prefix}-direct.rhitape`), direct);
  writeFileSync(join(directory, `${prefix}-gpu-driven.rhitape`), indirect);
}
