import { mkdirSync, writeFileSync } from 'node:fs';
import {
  type Buffer,
  RAY_QUERY_FEATURE,
  type Texture,
  type TextureView,
  type Tlas,
} from '@forgeax/engine-rhi';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import {
  createIrradianceFieldKernel,
  IRRADIANCE_FIELD_FRAME_BYTES,
  IRRADIANCE_FIELD_SURFACE_BYTES,
  type IrradianceFieldKernelInput,
  irradianceFieldKernelWgsl,
  packIrradianceFieldFrame,
} from '../../raytracing/irradiance-field';
import {
  createScreenProbeWorldKernel,
  type ScreenProbeResource,
  screenProbeWorldWgsl,
} from '../../raytracing/screen-probe-kernels';
import { ScreenProbeRayStatus } from '../../raytracing/screen-probe-plan';
import { createWorldAcceleration } from '../../raytracing/world-acceleration';
import { readBuffer } from './path-tracer.fixture';

// The same world-trace kernel and real TLAS used by Renderer, with a controlled
// Card shadow boundary. Dawn has no Ray Query; Native CI runs this explicitly.
it.skipIf(process.env.FORGEAX_WEBGPU_NODE !== 'wgpu-native')(
  'keeps a Screen Probe world ray on its supported Card texel across a lighting discontinuity',
  async () => {
    const recorder = attachRecorder(webgpu).unwrap();
    const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice({ requiredFeatures: [RAY_QUERY_FEATURE as GPUFeatureName] })
    ).unwrap();
    const raw = webgpu._internal_getRawDevice(
      recorder.backend.unwrapDeviceForSurface(device).unwrap(),
    );
    if (!raw) throw new Error('Card sampling requires an actual native device');
    const errors: string[] = [];
    raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const buffers: Buffer[] = [],
      textures: Texture[] = [];
    const make = (bytes: Uint8Array, uniform = false) => {
      const b = device
        .createBuffer({ size: bytes.byteLength, usage: (uniform ? 64 : 128) | 12 })
        .unwrap();
      buffers.push(b);
      device.queue.writeBuffer(b, 0, bytes).unwrap();
      return b;
    };
    const floats = (values: number[], uniform = false) =>
      make(new Uint8Array(new Float32Array(values).buffer), uniform);
    const atlas = (values: number[]) => {
      const texture = device
        .createTexture({ size: [2, 2], format: 'rgba32float', usage: 1 | 4 | 2 })
        .unwrap();
      textures.push(texture);
      device.queue
        .writeTexture({ texture }, new Float32Array(values), { bytesPerRow: 32 }, [2, 2])
        .unwrap();
      return device.createTextureView(texture, {}).unwrap();
    };
    const acceleration = createWorldAcceleration(device, {
      maxInstances: 1,
      maxTriangles: 1,
      maxBlasBuildsPerFrame: 1,
    }).unwrap();
    const result: {
      status: string;
      controls: Record<string, { production: number[]; bilinear: number[]; digest: string }>;
      errors: string[];
    } = { status: 'running', controls: {}, errors };
    try {
      const initialization = device.createCommandEncoder({}).unwrap();
      acceleration
        .set(
          {
            instanceId: 7,
            geometryId: 0,
            mask: 255,
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
          { geometryId: 0, positions: new Float32Array([-2, -2, 0, 2, -2, 0, 0, 2, 0]) },
        )
        .unwrap();
      acceleration.update(initialization).unwrap();
      const depth = device
        .createTexture({ size: [2, 2], format: 'depth32float', usage: 1 | 4 | 16 })
        .unwrap();
      textures.push(depth);
      const depthView = device.createTextureView(depth, {}).unwrap();
      initialization
        .beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: depthView,
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        })
        .end();
      device.queue.submit([initialization.finish().unwrap()]).unwrap();
      const cardBytes = new Uint8Array(80);
      const cf = new Float32Array(cardBytes.buffer),
        cu = new Uint32Array(cardBytes.buffer);
      cf.set([-1, -1, 0, 0, 1, 0, 0, 2, 0, 1, 0, 2, 0, 0, 1, 1]);
      cu.set([7, 1, 0, 0], 16);
      const cards = make(cardBytes),
        cardLit = floats(Array(16).fill(0));
      const probeBytes = new Uint8Array(64);
      const pf = new Float32Array(probeBytes.buffer),
        pu = new Uint32Array(probeBytes.buffer);
      for (const [i, x] of [-0.1, 0.1].entries()) {
        pf.set([x, -0.25, 1, 1, 0, 0, 1], i * 8);
        pu[i * 8 + 7] = i;
      }
      const probes = make(probeBytes),
        rayBytes = new Uint8Array(128 * 32),
        rays = make(rayBytes);
      const frameBytes = new Uint8Array(96);
      const ff = new Float32Array(frameBytes.buffer),
        fu = new Uint32Array(frameBytes.buffer);
      fu.set([2, 1, 2, 1, 2, 0, 8, 0]);
      ff[15] = 4;
      const frame = make(frameBytes, true),
        settings = make(new Uint8Array(new Uint32Array([1, 2, 0, 0]).buffer), true);
      const white = atlas(Array.from({ length: 16 }, () => 1)),
        normals = atlas(Array(16).fill(0));
      const source = screenProbeWorldWgsl('ray-query');
      const sampling = 'worldCardRadiance(hit,probeFrame.tuning.w,true)';
      expect(source.split(sampling)).toHaveLength(2);
      const kernels = [];
      for (const code of [
        source,
        source.replace(sampling, 'worldCardRadiance(hit,probeFrame.tuning.w,false)'),
      ]) {
        const module = (await recorder.backend.createShaderModule(device, { code })).unwrap();
        kernels.push(createScreenProbeWorldKernel(device, module, 'ray-query').unwrap());
      }
      const resources: Record<string, ScreenProbeResource> = {
        tlas: acceleration.tlas,
        traversalInstances: { buffer: acceleration.traversalInstances },
        faceNormals: { buffer: acceleration.faceNormals },
        cards: { buffer: cards },
        cardLit: { buffer: cardLit },
        rays: { buffer: rays },
        probesIn: { buffer: probes },
        probeFrame: { buffer: frame },
        cardSettings: { buffer: settings },
        albedoRoughness: white,
        normals,
        emissionMetallic: normals,
        f0Validity: white,
        depth: depthView,
      };
      for (const mode of ['contrast', 'constant', 'black'] as const) {
        const values = new Float32Array(16);
        for (let p = 0; p < 4; p++)
          values.set(
            [
              ...Array(3).fill(
                mode === 'constant' ? 2 : mode === 'contrast' && (p & 1) !== 0 ? 10 : 0,
              ),
              1,
            ],
            p * 4,
          );
        device.queue.writeBuffer(cardLit, 0, values).unwrap();
        const controls: number[][] = [];
        const capture = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        for (const kernel of kernels) {
          rayBytes.fill(0);
          const rf = new Float32Array(rayBytes.buffer),
            ru = new Uint32Array(rayBytes.buffer);
          for (let r = 0; r < 128; r++) ru[r * 8 + 3] = ScreenProbeRayStatus.culled << 12;
          for (const r of [0, 64]) {
            rf.set([0, 0, -1], r * 8);
            ru[r * 8 + 3] = (ScreenProbeRayStatus.world << 12) | 512;
          }
          device.queue.writeBuffer(rays, 0, rayBytes).unwrap();
          const encoder = device.createCommandEncoder({}).unwrap();
          const pass = encoder.beginComputePass({});
          kernel
            .record(
              pass,
              (name) => {
                const value = resources[name];
                if (!value) throw new Error(`missing ${name}`);
                return value;
              },
              undefined,
              128,
            )
            .unwrap();
          pass.end();
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
          const output = new DataView((await readBuffer(device, rays, rayBytes.byteLength)).buffer);
          controls.push([output.getFloat32(16, true), output.getFloat32(64 * 32 + 16, true)]);
          for (const r of [0, 64])
            expect((output.getUint32(r * 32 + 12, true) >> 12) & 7).toBe(
              ScreenProbeRayStatus.resolved,
            );
        }
        (await recorder.frameBoundary()).unwrap();
        const encoded = (await capture).unwrap();
        mkdirSync('artifacts/screen-probe/dawn', { recursive: true });
        writeFileSync(`artifacts/screen-probe/dawn/card-sampling-${mode}.rhitape`, encoded.bytes);
        result.controls[mode] = {
          production: controls[0] ?? [],
          bilinear: controls[1] ?? [],
          digest: encoded.digest,
        };
      }
      expect(result.controls.contrast?.production).toEqual([0, 10]);
      expect(result.controls.contrast?.bilinear[0]).toBeCloseTo(4, 5);
      expect(result.controls.contrast?.bilinear[1]).toBeCloseTo(6, 5);
      for (const mode of ['constant', 'black'] as const)
        for (const values of [result.controls[mode]?.production, result.controls[mode]?.bilinear])
          expect(values).toEqual(mode === 'constant' ? [2, 2] : [0, 0]);
      expect(errors).toEqual([]);
      result.status = 'pass';
    } catch (cause) {
      result.status = 'fail';
      throw cause;
    } finally {
      mkdirSync('artifacts/screen-probe/dawn', { recursive: true });
      writeFileSync(
        'artifacts/screen-probe/dawn/card-sampling-result.json',
        JSON.stringify(result, null, 2),
      );
      acceleration.dispose();
      for (const buffer of buffers) device.destroyBuffer(buffer).unwrap();
      for (const texture of textures) device.destroyTexture(texture).unwrap();
      (await recorder.dispose()).unwrap();
      raw.destroy();
    }
  },
);

it.skipIf(process.env.FORGEAX_WEBGPU_NODE !== 'wgpu-native')(
  'keeps Card shadow origins within exact Ray Query precision for directional and point lights',
  async () => {
    const recorder = attachRecorder(webgpu).unwrap();
    const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice({ requiredFeatures: [RAY_QUERY_FEATURE as GPUFeatureName] })
    ).unwrap();
    const raw = webgpu._internal_getRawDevice(
      recorder.backend.unwrapDeviceForSurface(device).unwrap(),
    );
    if (!raw) throw new Error('Card shadows require the actual native device');
    const errors: string[] = [];
    raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const buffers: Buffer[] = [];
    const textures: Texture[] = [];
    const make = (bytes: Uint8Array, uniform = false) => {
      const buffer = device
        .createBuffer({ size: bytes.byteLength, usage: (uniform ? 64 : 128) | 12 })
        .unwrap();
      buffers.push(buffer);
      device.queue.writeBuffer(buffer, 0, bytes).unwrap();
      return buffer;
    };
    const atlas = (values: number[]) => {
      const texture = device
        .createTexture({ size: [2, 2], format: 'rgba32float', usage: 7 })
        .unwrap();
      textures.push(texture);
      device.queue
        .writeTexture({ texture }, new Float32Array(values), { bytesPerRow: 32 }, [2, 2])
        .unwrap();
      return device.createTextureView(texture, {}).unwrap();
    };
    const acceleration = createWorldAcceleration(device, {
      maxInstances: 1,
      maxTriangles: 2,
      maxBlasBuildsPerFrame: 1,
    }).unwrap();
    const controls: {
      shader: string;
      mode: string;
      bias: number;
      expectedMask: number;
      masks: number[][];
      capture?: { digest: string; bytes: number };
    }[] = [];
    try {
      const initialization = device.createCommandEncoder({}).unwrap();
      acceleration
        .set(
          {
            instanceId: 7,
            geometryId: 0,
            mask: 255,
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
          {
            geometryId: 0,
            positions: new Float32Array([
              -2, -2, 0.05, 2, -2, 0.05, 2, 2, 0.05, -2, -2, 0.05, 2, 2, 0.05, -2, 2, 0.05,
            ]),
          },
        )
        .unwrap();
      acceleration.update(initialization).unwrap();
      const depth = device
        .createTexture({ size: [2, 2], format: 'depth32float', usage: 21 })
        .unwrap();
      textures.push(depth);
      const depthView = device.createTextureView(depth, {}).unwrap();
      initialization
        .beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: depthView,
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        })
        .end();
      device.queue.submit([initialization.finish().unwrap()]).unwrap();
      const cardBytes = new Uint8Array(80);
      const cf = new Float32Array(cardBytes.buffer);
      const cu = new Uint32Array(cardBytes.buffer);
      cf.set([-1, -1, 0, 0, 1, 0, 0, 2, 0, 1, 0, 2, 0, 0, 1, 1]);
      cu.set([7, 1, 0, 0], 16);
      const cards = make(cardBytes);
      const lightBytes = new Uint8Array(2048);
      const lf = new Float32Array(lightBytes.buffer);
      const lights = make(lightBytes, true);
      const frame = make(new Uint8Array(IRRADIANCE_FIELD_FRAME_BYTES), true);
      const cardSettings = make(new Uint8Array(new Uint32Array([1, 2, 0, 0]).buffer), true);
      const surfaces = make(new Uint8Array(4 * IRRADIANCE_FIELD_SURFACE_BYTES));
      const white = atlas(Array(16).fill(1));
      const normal = atlas(Array(16).fill(0));
      const resources: Partial<
        Record<IrradianceFieldKernelInput, TextureView | Tlas | { readonly buffer: Buffer }>
      > = {
        tlas: acceleration.tlas,
        traversalInstances: { buffer: acceleration.traversalInstances },
        faceNormals: { buffer: acceleration.faceNormals },
        cards: { buffer: cards },
        lights: { buffer: lights },
        frame: { buffer: frame },
        cardSettings: { buffer: cardSettings },
        surfaces: { buffer: surfaces },
        albedoRoughness: white,
        normals: normal,
        emissionMetallic: normal,
        f0Validity: white,
        depth: depthView,
      };
      const source = irradianceFieldKernelWgsl('ray-query').cardSurface;
      // FALSIFY the old field-sized origin and point-light endpoint clearance.
      const fieldBias = source
        .replace(
          'let origin=worldSurfaceOrigin(position,geometric,frame.trace.y);let bias=length(origin-position);var mask=0u;',
          'let bias=frame.trace.y;var mask=0u;',
        )
        .replace('Ray(origin,0.0,incoming,tMax,', 'Ray(position+geometric*bias,0.0,incoming,tMax,');
      for (const [shader, code] of [
        ['production', source],
        ['field-bias-falsifier', fieldBias],
      ] as const) {
        const module = (await recorder.backend.createShaderModule(device, { code })).unwrap();
        const kernel = createIrradianceFieldKernel(
          device,
          'cardSurface',
          module,
          'ray-query',
        ).unwrap();
        for (const mode of ['directional-close', 'point-close', 'point-clear'] as const) {
          for (const bias of [0.2, 0.0001]) {
            lf.fill(0);
            lf[3] = mode === 'directional-close' ? 1 : 2;
            lf.set([1, 1, 1, 0], 4);
            cf[0] = mode === 'directional-close' ? -1 : -0.05;
            cf[1] = mode === 'directional-close' ? -1 : -0.05;
            cf[2] = mode === 'point-clear' ? 0.2 : 0;
            cf[7] = mode === 'directional-close' ? 2 : 0.1;
            cf[11] = mode === 'directional-close' ? 2 : 0.1;
            if (mode === 'directional-close') lf.set([0, 0, -1, 0], 8);
            else lf.set([0, 0, mode === 'point-clear' ? 0.3 : 0.1], 0);
            device.queue.writeBuffer(lights, 0, lightBytes).unwrap();
            device.queue.writeBuffer(cards, 0, cardBytes).unwrap();
            device.queue
              .writeBuffer(
                frame,
                0,
                packIrradianceFieldFrame({
                  probeBudget: 1,
                  raysPerProbe: 1,
                  frameIndex: 0,
                  tileOffset: 0,
                  tileBudget: 1,
                  tileCount: 1,
                  lightCount: 1,
                  atlasWidth: 2,
                  cardResolution: 2,
                  radiosity: false,
                  environment: [0, 0, 0],
                  hysteresis: 0,
                  maxDistance: 4,
                  surfaceBias: bias,
                  depthClamp: 4,
                  cardMargin: 0,
                  gather: [2, 2, 2, 2],
                  query: new Uint8Array(new Uint32Array([256, 0x3f800000]).buffer),
                  reflections: [0, 0],
                }),
              )
              .unwrap();
            const expectedMask =
              mode === 'point-clear' || (shader === 'field-bias-falsifier' && bias === 0.2) ? 1 : 0;
            const row: (typeof controls)[number] = { shader, mode, bias, expectedMask, masks: [] };
            controls.push(row);
            const capture = recorder.captureFrame();
            (await recorder.frameBoundary()).unwrap();
            for (let completed = 0; completed < 60; completed++) {
              const encoder = device.createCommandEncoder({}).unwrap();
              const pass = encoder.beginComputePass({});
              kernel
                .record(
                  pass,
                  (name) => {
                    const value = resources[name];
                    if (!value) throw new Error(`missing Card shadow ${name}`);
                    return value;
                  },
                  4,
                )
                .unwrap();
              pass.end();
              device.queue.submit([encoder.finish().unwrap()]).unwrap();
              const bytes = await readBuffer(device, surfaces, 4 * IRRADIANCE_FIELD_SURFACE_BYTES);
              const view = new DataView(bytes.buffer);
              row.masks.push(
                Array.from({ length: 4 }, (_, i) =>
                  view.getUint32(i * IRRADIANCE_FIELD_SURFACE_BYTES + 12, true),
                ),
              );
            }
            (await recorder.frameBoundary()).unwrap();
            const tape = (await capture).unwrap();
            row.capture = { digest: tape.digest, bytes: tape.bytes.length };
            mkdirSync('artifacts/screen-probe/dawn', { recursive: true });
            writeFileSync(
              `artifacts/screen-probe/dawn/card-shadow-${shader}-${mode}-${bias}.rhitape`,
              tape.bytes,
            );
            expect(row.masks).toHaveLength(60);
            expect(row.masks.every((mask) => mask.every((value) => value === expectedMask))).toBe(
              true,
            );
          }
        }
      }
      expect(fieldBias).not.toBe(source);
      expect(errors).toEqual([]);
    } finally {
      mkdirSync('artifacts/screen-probe/dawn', { recursive: true });
      writeFileSync(
        'artifacts/screen-probe/dawn/card-shadow-origin-result.json',
        JSON.stringify({ controls, errors }, null, 2),
      );
      acceleration.dispose();
      for (const buffer of buffers) device.destroyBuffer(buffer).unwrap();
      for (const texture of textures) device.destroyTexture(texture).unwrap();
      (await recorder.dispose()).unwrap();
      raw.destroy();
    }
  },
);
