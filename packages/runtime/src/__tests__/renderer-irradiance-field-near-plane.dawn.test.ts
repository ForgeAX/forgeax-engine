import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { halfFloat } from '@forgeax/engine-math';
import { Camera, Materials, MeshRenderer } from '@forgeax/engine-render';
import {
  attachRecorder,
  bindingReadRequest,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import {
  createGiEvidenceManifest,
  visibleHdrHasSignal,
  withGiEvidenceOutcome,
} from './gi-evidence-outcome.fixture';
import {
  createIrradianceFieldHarness,
  irradianceFieldGi,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const width = 32;
const height = 32;
const center = { x: 16, y: 16 };
const far = 5.75;
const exactNear = 2.875;
// Binary-exact separation from the authored wall plane, small enough to keep
// the same visible surface while producing a strict reverse-Z depth < 1.
const controlNear = 2.8740234375;
const sourceDepthFormat = 'depth32float-stencil8';
const requestedNodeBackend =
  process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native' ? 'wgpu-native' : 'dawn';
const runId = `${Date.now()}-${process.pid}`;
const directory = join(tmpdir(), 'forgeax-gi-near-plane', runId);
mkdirSync(directory, { recursive: true });

interface Observation {
  readonly bytes: Uint8Array;
  readonly metadata: {
    readonly width: number;
    readonly height: number;
    readonly bytesPerRow: number;
  };
  readonly records?: Uint32Array;
}

interface CapturedCase {
  readonly name: string;
  readonly near: number;
  readonly tapeDigest: string;
  readonly receiptFrameId: number;
  readonly depth: Float32Array;
  readonly depthReadback: Uint8Array;
  readonly gathered: Float32Array;
  readonly upsampled: Float32Array;
  readonly visibleCovered: Uint8Array;
  readonly hdrBytes: Uint8Array;
  readonly hdrMetadata: Observation['metadata'];
  readonly centerHdrRgb: readonly [number, number, number];
  readonly centerField: readonly [number, number, number, number];
  readonly centerReflection: readonly [number, number, number, number] | undefined;
  readonly reflectionSignal: Float32Array | undefined;
  readonly visibleDepthOnePixels: number;
  readonly visibleDepthInteriorPixels: number;
  readonly centerIsVisible: boolean;
}

interface NearPlaneSignals {
  readonly exactCoverage: boolean;
  readonly controlCoverage: boolean;
  readonly controlFieldPositive: boolean;
  readonly controlCompositePositive: boolean;
  readonly reflectionCoverage: boolean;
  readonly controlReflectionPositive: boolean;
  readonly nearGatherPositive: boolean;
  readonly nearFieldPositive: boolean;
  readonly nearReflectionPositive: boolean;
  readonly nearCompositePositive: boolean;
  readonly nearReflectionCompositePositive: boolean;
}

function classifyNearPlaneSignals(signals: NearPlaneSignals) {
  if (!signals.exactCoverage) return 'NOT_COVERED_NO_VISIBLE_DEPTH_1_RECEIVER';
  if (
    !signals.controlCoverage ||
    !signals.controlFieldPositive ||
    !signals.controlCompositePositive
  )
    return 'NOT_COVERED_CONTROL_FIELD_NOT_POSITIVE';
  if (!signals.reflectionCoverage || !signals.controlReflectionPositive)
    return 'NOT_COVERED_REFLECTION_CONTROL_NOT_POSITIVE';
  if (!signals.nearGatherPositive) return 'RED_REPRODUCED_NEAR_PLANE_GATHER_MISSING';
  if (!signals.nearFieldPositive) return 'RED_REPRODUCED_NEAR_PLANE_GI_MISSING';
  if (!signals.nearReflectionPositive) return 'RED_REPRODUCED_NEAR_PLANE_REFLECTIONS_MISSING';
  if (!signals.nearCompositePositive || !signals.nearReflectionCompositePositive)
    return 'RED_REPRODUCED_NEAR_PLANE_FINAL_HDR_MISSING';
  return 'PASS';
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function pngChunk(name: string, data: Uint8Array): Buffer {
  const type = Buffer.from(name);
  const payload = Buffer.concat([type, Buffer.from(data)]);
  const chunk = Buffer.alloc(data.byteLength + 12);
  chunk.writeUInt32BE(data.byteLength, 0);
  payload.copy(chunk, 4);
  let crc = 0xffff_ffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb8_8320 ^ (crc >>> 1) : crc >>> 1;
  }
  chunk.writeUInt32BE((crc ^ 0xffff_ffff) >>> 0, data.byteLength + 8);
  return chunk;
}

/** Diagnostic-only fixed tone map of the actual linear-HDR observation. */
function linearHdrPng(bytes: Uint8Array, metadata: Observation['metadata']): Buffer {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows = Buffer.alloc(height * (1 + width * 3));
  const srgb = (value: number) => {
    const linear = Math.max(0, (value * 4) / (1 + value * 4));
    return Math.round(
      255 * (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055),
    );
  };
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const source = y * metadata.bytesPerRow + x * 8;
      const target = row + 1 + x * 3;
      for (let channel = 0; channel < 3; channel++) {
        const value = halfFloat.f16ToF32(data.getUint16(source + channel * 2, true));
        assert(Number.isFinite(value), 'diagnostic HDR pixels must remain finite');
        rows[target + channel] = srgb(value);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

it('keeps irradiance-field receivers on the exact reverse-Z near plane', {
  timeout: 900_000,
}, async () => {
  const files: { readonly name: string; readonly sha256: string; readonly byteLength: number }[] =
    [];
  const saveBytes = (name: string, bytes: Uint8Array) => {
    writeFileSync(join(directory, name), bytes);
    files.push({ name, sha256: digest(bytes), byteLength: bytes.byteLength });
  };
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    status: 'RUNNING',
    scope:
      'Actual Renderer near-plane admission regression. Within each field or reflection pair only Camera.near changes; geometry, material, emissive source and profile stay fixed. The reflection pair uses an explicitly reflective wall. Actual depth comes from the captured production binding and is cross-checked against same-frame visible-surface coverage. Positive signals qualify admission only, not full transport or the outstanding curved-scene gates.',
    sourceContract: {
      backend: `maintained Renderer fixture; requested Node backend=${requestedNodeBackend}; observed traversal is retained per capture`,
      width,
      height,
      cameraPosition: [0, 0, 0],
      cameraForward: [0, 0, -1],
      fovRadians: Math.PI / 3,
      aspect: 1,
      far,
      wallMesh: 'createProbeGlobalMesh(8, 8, 0.25)',
      wallTransformPosition: [0, 0, -3],
      expectedWallFrontPlaneZ: -2.875,
      sourceDepthFormat,
      wallMaterial: 'white standard, baseColor=[1,1,1,1], roughness=1, specular=0',
      emitterMesh: 'createProbeGlobalMesh(4, 4, 0.25)',
      emitterTransformPosition: [0, 0, 1],
      emitterMaterial: 'standard emission=[1,1,1], emissiveIntensity=4',
      gi: 'irradiance-field, zero environment, radiosity disabled',
      reflectionPair:
        'white standard wall, roughness=1, specular=1; maxRoughnessToTrace=0.4, roughnessFadeLength=0.1',
      cameraNearCases: { exactNear, controlNear },
      diagnosticPng:
        'linear-HDR RGB with fixed x4 Reinhard and sRGB mapping; raw rgba16float bytes are preserved separately',
    },
    captures: {},
    files,
  };
  const recorder = attachRecorder(webgpu).unwrap();
  let harness: Awaited<ReturnType<typeof createIrradianceFieldHarness>> | undefined;
  const publication = createGiEvidenceManifest(join(directory, 'manifest.json'), result);
  await withGiEvidenceOutcome(
    result,
    async () => {
      const h = await createIrradianceFieldHarness({
        rhi: recorder.backend.rhi,
        manifest,
        instrumentation: {
          onDeviceLost: () => recorder.deviceLost(),
          resolveSurfaceDevice: (
            device: Parameters<typeof recorder.backend.unwrapDeviceForSurface>[0],
          ) => ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
        },
      });
      harness = h;
      h.world.set(h.camera, Camera, { near: exactNear, far }).unwrap();
      h.setGi(irradianceFieldGi({ radiosity: false }));
      await h.settle(0);

      // The same offscreen emissive source used by the ordinary GI regression.
      // It makes the field positive while remaining out of the camera view.
      h.spawn(h.emitterMesh, h.emissive, [0, 0, 1]);
      await h.settle(24);
      let capturingReflections = false;

      const capture = async (name: string, near: number): Promise<CapturedCase> => {
        const requestObservation = h.renderer.requestObservation;
        assert(requestObservation, 'renderer supports the requested frame observations');
        renderValue(requestObservation.call(h.renderer, ['linear-hdr', 'visible-surface']));
        const pending = recorder.captureFrame();
        renderValue(await recorder.frameBoundary());
        const receipt = await h.draw();
        const observations = renderValue(
          await h.renderer.observe(receipt, {
            include: ['linear-hdr', 'visible-surface'],
          }),
        ).observations;
        const hdr = observations?.find((item) => item.domain === 'linear-hdr');
        const visible = observations?.find((item) => item.domain === 'visible-surface');
        assert(hdr && visible, 'HDR and visible-surface data belong to this completed frame');
        expect(hdr.metadata.frameId).toBe(receipt.frameId);
        expect(visible.metadata.frameId).toBe(receipt.frameId);
        expect(hdr.metadata.width).toBe(width);
        expect(hdr.metadata.height).toBe(height);
        expect(hdr.metadata.format).toBe('rgba16float');
        expect(hdr.metadata.bytesPerRow).toBeGreaterThanOrEqual(width * 8);
        expect(hdr.bytes.byteLength).toBe(hdr.metadata.bytesPerRow * height);
        expect(visible.metadata.width).toBe(width);
        expect(visible.metadata.height).toBe(height);
        expect(visible.metadata.format).toBe('rgba32uint');
        expect(visible.metadata.bytesPerRow).toBeGreaterThanOrEqual(width * 16);
        expect(visible.bytes.byteLength).toBe(visible.metadata.bytesPerRow * height);
        assert(visible.records, 'visible-surface records are present');
        expect(visible.records.length).toBeGreaterThan(0);
        renderValue(await recorder.frameBoundary());
        const encoded = renderValue(await pending);
        saveBytes(`${name}.rhitape`, encoded.bytes);
        const tape = decodeTape(encoded.bytes).unwrap();
        const model = buildFrameModel(tape);
        const upsample = model.works.find((work) =>
          work.pipeline.shaders.some((shader) => shader.entryPoint === 'upsampleField'),
        );
        assert(upsample, 'captured production frame contains upsampleField');
        const reflectionWork = model.works.find((work) =>
          work.pipeline.shaders.some((item) => item.entryPoint === 'generateFieldReflections'),
        );
        if (capturingReflections)
          assert(
            reflectionWork,
            'the reflective material/profile produces the real reflection work',
          );
        const shader = upsample.pipeline.shaders.find(
          (item) => item.entryPoint === 'upsampleField',
        );
        assert(shader?.source, 'captured production upsampleField source is present');
        const depthRequest = renderValue(bindingReadRequest(upsample, 0, 6));
        const adapter = renderValue(await webgpu.rhi.requestAdapter());
        const device = renderValue(
          await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits)),
        );
        const replay = renderValue(
          await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule }),
        );
        let depthRead: Uint8Array;
        let capturedDepthFormat: string;
        try {
          const rows = renderValue(await replay.readAtWorks([depthRequest]));
          const depthRow = rows[0];
          assert(depthRow, 'upsampleField depth binding returned a readback row');
          const depthResult = renderValue(depthRow);
          saveBytes(`${name}.depth.f32`, depthResult.bytes);
          saveBytes(
            `${name}.depth-metadata.json`,
            Buffer.from(
              JSON.stringify({
                format: depthResult.format,
                width: depthResult.width,
                height: depthResult.height,
                byteLength: depthResult.bytes.byteLength,
                decodedRecord: 'one little-endian f32 depth value per texel',
              }),
            ),
          );
          expect(depthResult.width).toBe(width);
          expect(depthResult.height).toBe(height);
          assert(
            depthResult.format === sourceDepthFormat,
            'upsampleField depth binding retains the Renderer source depth-stencil format',
          );
          expect(depthResult.bytes.byteLength).toBe(width * height * 4);
          depthRead = depthResult.bytes;
          capturedDepthFormat = depthResult.format;
        } finally {
          try {
            renderValue(await replay.dispose());
          } finally {
            webgpu.disposeDevice(device);
          }
        }

        const depthView = new DataView(
          depthRead.buffer,
          depthRead.byteOffset,
          depthRead.byteLength,
        );
        const depth = Float32Array.from({ length: width * height }, (_, pixel) =>
          depthView.getFloat32(pixel * 4, true),
        );
        expect(depth.every(Number.isFinite)).toBe(true);
        const visibleView = new DataView(
          visible.bytes.buffer,
          visible.bytes.byteOffset,
          visible.bytes.byteLength,
        );
        const visibleCovered = new Uint8Array(width * height);
        let visibleDepthOnePixels = 0;
        let visibleDepthInteriorPixels = 0;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            const visibleOffset = y * visible.metadata.bytesPerRow + x * 16;
            const record = visibleView.getUint32(visibleOffset, true);
            const covered = (visibleView.getUint32(visibleOffset + 12, true) & 1) !== 0;
            if (covered) expect(record).toBeGreaterThan(0);
            visibleCovered[pixel] = covered ? 1 : 0;
            const depthValue = depth[pixel] ?? 0;
            if (covered && depthValue === 1) visibleDepthOnePixels++;
            if (covered && depthValue > 0 && depthValue < 1) visibleDepthInteriorPixels++;
          }
        const gathered = await h.read('gathered');
        const upsampled = await h.read('upsampled');
        const reflectionSignal = capturingReflections
          ? await h.read('reflection-signal')
          : undefined;
        if (reflectionSignal) {
          expect(reflectionSignal.length).toBe(width * height * 4);
          expect(reflectionSignal.every(Number.isFinite)).toBe(true);
          for (let pixel = 0; pixel < width * height; pixel++)
            expect([0, 1]).toContain(reflectionSignal[pixel * 4 + 3]);
          saveBytes(
            `${name}.reflection-signal.f32`,
            new Uint8Array(
              reflectionSignal.buffer,
              reflectionSignal.byteOffset,
              reflectionSignal.byteLength,
            ),
          );
        }
        expect(gathered.every(Number.isFinite)).toBe(true);
        expect(upsampled.every(Number.isFinite)).toBe(true);
        for (let channel = 3; channel < upsampled.length; channel += 4)
          expect([0, 1]).toContain(upsampled[channel]);
        const pixel = center.y * width + center.x;
        const field = Array.from(upsampled.slice(pixel * 4, pixel * 4 + 4)) as [
          number,
          number,
          number,
          number,
        ];
        const hdrView = new DataView(hdr.bytes.buffer, hdr.bytes.byteOffset, hdr.bytes.byteLength);
        const hdrOffset = center.y * hdr.metadata.bytesPerRow + center.x * 8;
        const centerHdrRgb = [0, 1, 2].map((channel) =>
          halfFloat.f16ToF32(hdrView.getUint16(hdrOffset + channel * 2, true)),
        ) as [number, number, number];
        const centerIsVisible = visibleCovered[pixel] === 1;
        const diffuseGi = h.inspection();
        expect(diffuseGi.state).toBe('ready');
        const captureResult: CapturedCase = {
          name,
          near,
          tapeDigest: encoded.digest,
          receiptFrameId: receipt.frameId,
          depth,
          depthReadback: new Uint8Array(depthRead),
          gathered,
          upsampled,
          visibleCovered,
          hdrBytes: new Uint8Array(hdr.bytes),
          hdrMetadata: hdr.metadata,
          centerHdrRgb,
          centerField: field,
          centerReflection: reflectionSignal
            ? (Array.from(reflectionSignal.slice(pixel * 4, pixel * 4 + 4)) as [
                number,
                number,
                number,
                number,
              ])
            : undefined,
          reflectionSignal,
          visibleDepthOnePixels,
          visibleDepthInteriorPixels,
          centerIsVisible,
        };
        saveBytes(
          `${name}.gathered.f32`,
          new Uint8Array(gathered.buffer, gathered.byteOffset, gathered.byteLength),
        );
        saveBytes(
          `${name}.upsampled.f32`,
          new Uint8Array(upsampled.buffer, upsampled.byteOffset, upsampled.byteLength),
        );
        saveBytes(`${name}.linear-hdr.rgba16f`, captureResult.hdrBytes);
        saveBytes(`${name}.visible-covered.u8`, visibleCovered);
        saveBytes(`${name}.visible-surface.rgba32uint`, new Uint8Array(visible.bytes));
        saveBytes(
          `${name}.visible-surface-records.u32`,
          new Uint8Array(
            visible.records.buffer,
            visible.records.byteOffset,
            visible.records.byteLength,
          ),
        );
        saveBytes(
          `${name}.linear-hdr-diagnostic.png`,
          linearHdrPng(captureResult.hdrBytes, captureResult.hdrMetadata),
        );
        (result.captures as Record<string, unknown>)[name] = {
          near,
          far,
          tapeDigest: encoded.digest,
          capturedShaderSha256: digest(new TextEncoder().encode(shader.source)),
          receipt: {
            frameId: receipt.frameId,
            deviceGeneration: receipt.deviceGeneration,
            graphGeneration: hdr.metadata.graphGeneration,
            backendId: hdr.metadata.backendId ?? null,
          },
          upsampleWorkIndex: upsample.workIndex,
          depthBindingResourceId: depthRequest.resourceId,
          depthBindingWorkIndex: depthRequest.workIndex,
          depthFormat: capturedDepthFormat,
          depthOneVisiblePixels: visibleDepthOnePixels,
          depthInteriorVisiblePixels: visibleDepthInteriorPixels,
          depthRange: [Math.min(...depth), Math.max(...depth)],
          centerDepth: depth[pixel],
          centerVisible: centerIsVisible,
          centerField: field,
          centerReflection: captureResult.centerReflection,
          reflectionWorkIndex: reflectionWork?.workIndex,
          centerLinearHdrRgb: centerHdrRgb,
          diffuseGi,
          sourceReceiverCoverage: {
            visiblePixelCount: visibleCovered.reduce((sum, value) => sum + value, 0),
            depthOneVisiblePixels: visibleDepthOnePixels,
            depthInteriorVisiblePixels: visibleDepthInteriorPixels,
          },
        };
        return captureResult;
      };

      const exact = await capture('near-exact', exactNear);
      h.world.set(h.camera, Camera, { near: controlNear, far }).unwrap();
      await h.settle(4);
      const control = await capture('near-control', controlNear);

      // A separate positive-control pair covers the third receiver-depth gate.
      // The reflective wall/profile are fixed within this pair; only near changes.
      const reflective = await h.publish(
        Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 1, specular: 1 }),
      );
      h.world.set(h.wall, MeshRenderer, { materials: [reflective] }).unwrap();
      h.setGi({
        ...irradianceFieldGi({ radiosity: false }),
        reflections: { maxRoughnessToTrace: 0.4, roughnessFadeLength: 0.1 },
      });
      capturingReflections = true;
      h.world.set(h.camera, Camera, { near: exactNear, far }).unwrap();
      await h.settle(24);
      const reflectionExact = await capture('reflection-near-exact', exactNear);
      h.world.set(h.camera, Camera, { near: controlNear, far }).unwrap();
      await h.settle(4);
      const reflectionControl = await capture('reflection-near-control', controlNear);

      const exactCenterPixel = center.y * width + center.x;
      const controlCenterDepth = control.depth[exactCenterPixel] ?? 0;
      const samePixelNearPlaneToInteriorTransitions = exact.depth.reduce(
        (count, depth, pixel) =>
          count +
          (exact.visibleCovered[pixel] === 1 &&
          control.visibleCovered[pixel] === 1 &&
          depth === 1 &&
          (control.depth[pixel] ?? 0) > 0 &&
          (control.depth[pixel] ?? 0) < 1
            ? 1
            : 0),
        0,
      );
      const exactCoverage =
        exact.visibleDepthOnePixels === width * height &&
        exact.centerIsVisible &&
        exact.depth[exactCenterPixel] === 1 &&
        samePixelNearPlaneToInteriorTransitions === width * height;
      const controlCoverage =
        control.visibleDepthInteriorPixels === width * height &&
        control.centerIsVisible &&
        controlCenterDepth > 0 &&
        controlCenterDepth < 1;
      const everySignalPositive = (values: Float32Array | undefined, pixels: number) => {
        if (!values || values.length !== pixels * 4) return false;
        for (let pixel = 0; pixel < pixels; pixel++) {
          const offset = pixel * 4;
          if (
            values[offset + 3] !== 1 ||
            ![values[offset], values[offset + 1], values[offset + 2]].some(
              (value) => value !== undefined && value > 0,
            )
          )
            return false;
        }
        return true;
      };
      const gatherPixels = Math.ceil(width / 2) * Math.ceil(height / 2);
      const controlFieldPositive =
        everySignalPositive(control.gathered, gatherPixels) &&
        everySignalPositive(control.upsampled, width * height);
      const controlCompositePositive = control.centerHdrRgb.some((value) => value > 0.05);
      const nearGatherPositive = everySignalPositive(exact.gathered, gatherPixels);
      const nearFieldPositive = everySignalPositive(exact.upsampled, width * height);
      const reflectionCoverage =
        reflectionExact.visibleDepthOnePixels === width * height &&
        reflectionControl.visibleDepthInteriorPixels === width * height;
      const controlReflectionPositive = everySignalPositive(
        reflectionControl.reflectionSignal,
        width * height,
      );
      const nearReflectionPositive = everySignalPositive(
        reflectionExact.reflectionSignal,
        width * height,
      );
      const nearCompositePositive = visibleHdrHasSignal(
        exact.hdrBytes,
        exact.hdrMetadata,
        exact.visibleCovered,
      );
      const nearReflectionCompositePositive = visibleHdrHasSignal(
        reflectionExact.hdrBytes,
        reflectionExact.hdrMetadata,
        reflectionExact.visibleCovered,
      );
      const status = classifyNearPlaneSignals({
        exactCoverage,
        controlCoverage,
        controlFieldPositive,
        controlCompositePositive,
        reflectionCoverage,
        controlReflectionPositive,
        nearGatherPositive,
        nearFieldPositive,
        nearReflectionPositive,
        nearCompositePositive,
        nearReflectionCompositePositive,
      });
      const errors = h.errors.map(String);
      Object.assign(result, {
        signalStatus: status,
        coverage: {
          exactNearHasActualVisibleDepthOneSurface: exactCoverage,
          smallerNearHasVisibleInteriorDepthSurface: controlCoverage,
          controlFieldPositive,
          controlCompositePositive,
          nearPlaneFieldPositive: nearFieldPositive,
          nearPlaneGatherPositive: nearGatherPositive,
          reflectionDepthCoverage: reflectionCoverage,
          controlReflectionPositive,
          nearPlaneReflectionPositive: nearReflectionPositive,
          nearPlaneFinalHdrPositive: nearCompositePositive,
          nearPlaneReflectionFinalHdrPositive: nearReflectionCompositePositive,
        },
        reflectionComparison: {
          scope:
            'Actual reflection-signal before material response; admission only, not a reflection energy oracle.',
          material: 'white standard, roughness=1, specular=1',
          exactNearCenter: {
            depth: reflectionExact.depth[exactCenterPixel],
            signal: reflectionExact.centerReflection,
          },
          controlCenter: {
            depth: reflectionControl.depth[exactCenterPixel],
            signal: reflectionControl.centerReflection,
          },
        },
        comparison: {
          samePixelNearPlaneToInteriorTransitions,
          exactNearCenter: {
            depth: exact.depth[exactCenterPixel],
            field: exact.centerField,
            linearHdrRgb: exact.centerHdrRgb,
          },
          controlCenter: {
            depth: controlCenterDepth,
            field: control.centerField,
            linearHdrRgb: control.centerHdrRgb,
          },
        },
        errors,
        files,
      });
      expect(errors, JSON.stringify({ status, errors })).toEqual([]);
      expect(status, JSON.stringify(result)).toBe('PASS');
    },
    async () => {
      try {
        if (harness) await harness.dispose();
      } finally {
        renderValue(await recorder.dispose());
      }
    },
    () => {
      Object.assign(result, { completedAt: new Date().toISOString(), files });
      publication.publish();
    },
    publication.invalidate,
  );
});
