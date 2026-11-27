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
import { rebuildCardOwnerIndex } from '../../raytracing/card-owner-index';
import {
  createIrradianceFieldKernel,
  IRRADIANCE_FIELD_FAR_RADIANCE,
  IRRADIANCE_FIELD_FRAME_BYTES,
  IRRADIANCE_FIELD_SURFACE_BYTES,
  type IrradianceFieldKernelInput,
  IrradianceFieldRayStatus,
  irradianceFieldKernelWgsl,
  packIrradianceFieldFrame,
  packIrradianceFieldUniform,
} from '../../raytracing/irradiance-field';
import {
  createScreenProbeWorldKernel,
  type ScreenProbeResource,
  screenProbeWorldWgsl,
} from '../../raytracing/screen-probe-kernels';
import { ScreenProbeRayStatus } from '../../raytracing/screen-probe-plan';
import { createWorldAcceleration } from '../../raytracing/world-acceleration';
import { readBuffer } from './path-tracer.fixture';
import { packCardSamplingInputs } from './screen-probe-card-sampling.fixture';

function cardLighting(mode: 'contrast' | 'constant' | 'black' | 'invalid-texels'): Float32Array {
  const values = new Float32Array(16);
  for (let texel = 0; texel < 4; texel++) {
    const light = mode === 'constant' ? 2 : mode !== 'black' && (texel & 1) !== 0 ? 10 : 0;
    values.set([light, light, light, 1], texel * 4);
  }
  return values;
}

// The same world-trace kernel and real TLAS used by Renderer, with a controlled
// Card shadow boundary. Dawn has no Ray Query; Native CI runs this explicitly.
it.skipIf(process.env.FORGEAX_WEBGPU_NODE !== 'wgpu-native')(
  'filters supported hardware Card texels while preserving geometry and trace intervals',
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
      controls: Record<string, { production: number[]; nearest: number[]; digest: string }>;
      errors: string[];
      farStrata?: number[][];
      nearRefresh?: { screenProbeChanged: number; standaloneChanged: number };
      interval?: {
        producerStart: number;
        screenBoundary: number;
        screenStatuses: number[];
        screenDistances: number[];
        near: number[][];
        far: number[][];
      };
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
      rebuildCardOwnerIndex(cardBytes, 1);
      const cards = make(cardBytes),
        cardLit = floats(Array(16).fill(0));
      const packedInputs = packCardSamplingInputs();
      const probes = make(packedInputs.probes),
        rayBytes = new Uint8Array(128 * 32),
        rays = make(rayBytes);
      const frame = make(packedInputs.frame, true),
        settings = make(new Uint8Array(new Uint32Array([1, 2, 0, 0]).buffer), true);
      const white = atlas(Array.from({ length: 16 }, () => 1)),
        normals = atlas(Array(16).fill(0)),
        missingRight = atlas(Array.from({ length: 16 }, (_, lane) => (lane % 8 === 7 ? 0 : 1)));
      const source = screenProbeWorldWgsl('ray-query');
      const sampling = /(worldCardRadiance\(hit,probeFrame\.tuning\.w,)(?:true|false),/g;
      expect([...source.matchAll(sampling)]).toHaveLength(1);
      const kernels = [];
      for (const code of [source, source.replace(sampling, '$1true,')]) {
        const module = (await recorder.backend.createShaderModule(device, { code })).unwrap();
        kernels.push((await createScreenProbeWorldKernel(device, module, 'ray-query')).unwrap());
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
      for (const mode of ['contrast', 'constant', 'black', 'invalid-texels'] as const) {
        device.queue.writeBuffer(cardLit, 0, cardLighting(mode)).unwrap();
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
                if (name === 'f0Validity' && mode === 'invalid-texels') return missingRight;
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
          nearest: controls[1] ?? [],
          digest: encoded.digest,
        };
      }
      // Use the compact hardware entry and the same real TLAS. A finite
      // prequalified boundary shortens a ray only after preserving nearer hits.
      const compactSource = screenProbeWorldWgsl('ray-query', false, undefined, true);
      const compactModule = (
        await recorder.backend.createShaderModule(device, { code: compactSource })
      ).unwrap();
      const compact = (
        await createScreenProbeWorldKernel(device, compactModule, 'ray-query', true, true)
      ).unwrap();
      const traceList = make(new Uint8Array(new Uint32Array([5, 0, 1, 2, 3, 64]).buffer));
      const rf = new Float32Array(rayBytes.buffer);
      const ru = new Uint32Array(rayBytes.buffer);
      const nearUniform = packIrradianceFieldUniform(
        { origin: [0, 0, 0], spacing: 1, dimensions: [2, 2, 2], probeCount: 8, levels: 1 },
        [{ window: [0, 0, 0], min: [0, 0, 0], max: [2, 2, 2] }],
        true,
      );
      const producerStart = new DataView(nearUniform.buffer).getFloat32(76, true);
      const screenBoundary = 2 * producerStart;
      const boundaries = [0.25, screenBoundary, -1, 5];
      const farther = packedInputs.probes.slice();
      new DataView(farther.buffer).setFloat32(farther.byteLength / 2 + 8, 3.75, true);
      device.queue.writeBuffer(probes, 0, farther).unwrap();
      rf.set([0, 0, -1], 64 * 8);
      ru[64 * 8 + 3] = (ScreenProbeRayStatus.world << 12) | 512;
      rf[64 * 8 + 7] = screenBoundary;
      for (const [slot, distance] of boundaries.entries()) {
        rf.set(slot < 2 ? [0, 0, -1] : [1, 0, 0], slot * 8);
        ru[slot * 8 + 3] = (ScreenProbeRayStatus.world << 12) | 512;
        rf[slot * 8 + 7] = distance;
      }
      device.queue.writeBuffer(rays, 0, rayBytes).unwrap();
      const encoder = device.createCommandEncoder({}).unwrap();
      const pass = encoder.beginComputePass({});
      compact
        .record(
          pass,
          (name) => {
            const resource = name === 'traceListIn' ? { buffer: traceList } : resources[name];
            if (!resource) throw new Error(`missing ${name}`);
            return resource;
          },
          undefined,
          5,
        )
        .unwrap();
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const traced = new DataView((await readBuffer(device, rays, rayBytes.byteLength)).buffer);
      const statuses = boundaries.map(
        (_, slot) => (traced.getUint32(slot * 32 + 12, true) >>> 12) & 7,
      );
      const distances = boundaries.map((_, slot) => traced.getFloat32(slot * 32 + 28, true));
      expect(statuses).toEqual([
        ScreenProbeRayStatus.cacheBoundary,
        ScreenProbeRayStatus.resolved,
        ScreenProbeRayStatus.resolved,
        ScreenProbeRayStatus.resolved,
      ]);
      expect(distances[0]).toBe(0.25);
      expect(distances[1]).toBeCloseTo(1, 4);
      expect(distances.slice(2)).toEqual([4, 4]);
      expect((traced.getUint32(64 * 32 + 12, true) >>> 12) & 7).toBe(
        ScreenProbeRayStatus.cacheBoundary,
      );
      expect(traced.getFloat32(64 * 32 + 28, true)).toBe(screenBoundary);

      // The same production cache trace, with a fixed ray direction to put the
      // high-radiance Card deterministically on either side of ProbeTMin.
      const productionTrace = irradianceFieldKernelWgsl('ray-query').traceProbes;
      const direction = 'let direction=traceProbeDirection(probe,traceUpdate,i%rays,rays,far);';
      expect(productionTrace.split(direction)).toHaveLength(2);
      const fixedTrace = productionTrace.replace(direction, 'let direction=vec3f(0.0,0.0,-1.0);');
      const probeModule = (
        await recorder.backend.createShaderModule(device, { code: fixedTrace })
      ).unwrap();
      const probeKernel = (
        await createIrradianceFieldKernel(device, 'traceProbes', probeModule, 'ray-query')
      ).unwrap();
      const runFrameData = packIrradianceFieldFrame({
        probeBudget: 2,
        raysPerProbe: 1,
        frameIndex: 0,
        tileOffset: 0,
        tileBudget: 0,
        tileCount: 1,
        lightCount: 0,
        atlasWidth: 2,
        cardResolution: 2,
        radiosity: false,
        environment: [0.125, 0.25, 0.5],
        hysteresis: 0,
        maxDistance: 4,
        surfaceBias: 0,
        depthClamp: 4,
        cardMargin: 0.05,
        gather: [1, 1, 1, 1],
        query: new Uint8Array(new Uint32Array([128, 0x3e800000]).buffer),
        reflections: [0, 0],
        worldSource: { traversal: 'ray-query' },
      });
      const runFrame = make(runFrameData, true);
      const origins = new Uint8Array(64);
      const placed = new Float32Array(origins.buffer);
      placed.set([-0.1, -0.25, 1], 0);
      placed.set([-0.1, -0.25, 3.75], 8);
      const probeOrigins = make(origins);
      const probeRays = make(new Uint8Array(2 * 64 * 32));
      const farUniform = nearUniform.slice();
      new Uint32Array(farUniform.buffer)[15] = IRRADIANCE_FIELD_FAR_RADIANCE;
      const brightCard = new Float32Array(16);
      for (let i = 0; i < 4; i++) brightCard.set([16, 8, 4, 1], i * 4);
      device.queue.writeBuffer(cardLit, 0, brightCard).unwrap();
      const probeTrace = async (uniform: Uint8Array, kernel = probeKernel, raysPerProbe = 1) => {
        const domain = make(uniform, true);
        new Uint32Array(runFrameData.buffer)[2] = raysPerProbe;
        device.queue.writeBuffer(runFrame, 0, runFrameData).unwrap();
        const traceInputs = {
          ...resources,
          field: { buffer: domain },
          frame: { buffer: runFrame },
          probeRays: { buffer: probeRays },
          probeOrigins: { buffer: probeOrigins },
        } as Record<string, ScreenProbeResource>;
        const commands = device.createCommandEncoder({}).unwrap();
        const trace = commands.beginComputePass({});
        kernel
          .record(
            trace,
            (name) => {
              const resource = traceInputs[name];
              if (resource === undefined) throw new Error(`missing ${name}`);
              return resource;
            },
            2 * raysPerProbe,
          )
          .unwrap();
        trace.end();
        device.queue.submit([commands.finish().unwrap()]).unwrap();
        const byteCount = 2 * raysPerProbe * 32;
        const bytes = await readBuffer(device, probeRays, byteCount);
        const values = new Float32Array(bytes.buffer, bytes.byteOffset, byteCount / 4);
        return Array.from({ length: raysPerProbe * 2 }, (_, i) =>
          Array.from(values.slice(i * 8, (i + 1) * 8)),
        );
      };
      const near = await probeTrace(nearUniform);
      const far = await probeTrace(farUniform);
      result.interval = {
        producerStart,
        screenBoundary,
        screenStatuses: statuses,
        screenDistances: distances,
        near,
        far,
      };
      expect(near.map((row) => row.slice(0, 3))).toEqual([
        [16, 8, 4],
        [16, 8, 4],
      ]);
      expect(far.map((row) => row.slice(0, 3))).toEqual([
        [0.125, 0.25, 0.5],
        [16, 8, 4],
      ]);
      expect(far.map((row) => row[7])).toEqual([
        IrradianceFieldRayStatus.miss,
        IrradianceFieldRayStatus.hit,
      ]);
      expect(far[1]?.[3]).toBeCloseTo(3.75, 4);
      device.queue.writeBuffer(cardLit, 0, cardLighting('contrast')).unwrap();
      const nearContrast = await probeTrace(nearUniform);
      const farContrast = await probeTrace(farUniform);
      expect(nearContrast.map((row) => row[0])).toEqual([0, 0]);
      expect(farContrast[0]?.[0]).toBe(0.125);
      expect(farContrast[1]?.[0]).toBeCloseTo(4, 5);
      device.queue.writeBuffer(cardLit, 0, brightCard).unwrap();
      const angularModule = (
        await recorder.backend.createShaderModule(device, { code: productionTrace })
      ).unwrap();
      const angularKernel = (
        await createIrradianceFieldKernel(device, 'traceProbes', angularModule, 'ray-query')
      ).unwrap();
      const emitted = await probeTrace(farUniform, angularKernel, 64);
      const farStrata: number[][] = [];
      for (let probe = 0; probe < 2; probe++) {
        const strata = new Set<number>();
        for (let ray = 0; ray < 64; ray++) {
          const [dx, dy, dz] = emitted[probe * 64 + ray]?.slice(4, 7) ?? [];
          if (dx === undefined || dy === undefined || dz === undefined)
            throw Error('Missing ray direction');
          expect(Math.hypot(dx, dy, dz)).toBeCloseTo(1, 5);
          const l1 = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          const x = dx / l1,
            y = dy / l1;
          const u = dz < 0 ? (1 - Math.abs(y)) * Math.sign(x) : x;
          const v = dz < 0 ? (1 - Math.abs(x)) * Math.sign(y) : y;
          strata.add(Math.floor((u + 1) * 4) + 8 * Math.floor((v + 1) * 4));
        }
        expect([...strata].sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i));
        farStrata.push([...strata]);
      }
      result.farStrata = farStrata;
      const standalone = nearUniform.slice();
      // This word publishes whether the far Screen Probe cache is available.
      new DataView(standalone.buffer).setFloat32(76, 0, true);
      const cacheInitial = await probeTrace(nearUniform, angularKernel, 64);
      const fieldInitial = await probeTrace(standalone, angularKernel, 64);
      const refreshed = new DataView(origins.buffer);
      refreshed.setUint32(16, 41, true);
      refreshed.setUint32(48, 97, true);
      device.queue.writeBuffer(probeOrigins, 0, origins).unwrap();
      const cacheRefreshed = await probeTrace(nearUniform, angularKernel, 64);
      const fieldRefreshed = await probeTrace(standalone, angularKernel, 64);
      const changedDirections = (before: number[][], after: number[][]) =>
        before.filter((row, ray) => row.slice(4, 7).some((v, axis) => v !== after[ray]?.[4 + axis]))
          .length;
      result.nearRefresh = {
        screenProbeChanged: changedDirections(cacheInitial, cacheRefreshed),
        standaloneChanged: changedDirections(fieldInitial, fieldRefreshed),
      };
      expect(result.nearRefresh.screenProbeChanged).toBe(0);
      expect(result.nearRefresh.standaloneChanged).toBe(128);
      expect(result.controls.contrast?.nearest).toEqual([0, 10]);
      expect(result.controls.contrast?.production[0]).toBeCloseTo(4, 5);
      expect(result.controls.contrast?.production[1]).toBeCloseTo(6, 5);
      for (const mode of ['constant', 'black', 'invalid-texels'] as const)
        for (const values of [result.controls[mode]?.production, result.controls[mode]?.nearest])
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
  'keeps Card shadow visibility exact with close or unresolved Ray Query intersections',
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
      maxInstances: 2,
      maxTriangles: 4,
      maxBlasBuildsPerFrame: 1,
    }).unwrap();
    const controls: {
      shader: string;
      mode: string;
      bias: number;
      expectedMask: number;
      masks: number[][];
      expectedValid: number;
      validity: number[][];
      capture?: { digest: string; bytes: number };
    }[] = [];
    try {
      const initialization = device.createCommandEncoder({}).unwrap();
      const corners = [
        [-2, -2],
        [2, -2],
        [2, 2],
        [-2, -2],
        [2, 2],
        [-2, 2],
      ] as const;
      const geometry = {
        geometryId: 0,
        positions: new Float32Array(
          [0.05, 0.025].flatMap((z) => corners.flatMap(([x, y]) => [x, y, z])),
        ),
      };
      acceleration
        .set(
          {
            instanceId: 7,
            geometryId: 0,
            mask: 255,
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            surfaceCoverage: { kind: 'partial', opaquePrimitives: Uint32Array.of(3) },
          },
          geometry,
        )
        .unwrap();
      acceleration
        .set(
          {
            instanceId: 8,
            geometryId: 0,
            mask: 255,
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
            surfaceCoverage: 'unknown',
          },
          geometry,
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
      rebuildCardOwnerIndex(cardBytes, 1);
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
      const compareCardVisibility = async () => {
        for (const [shader, code] of [
          ['production', source],
          ['field-bias-falsifier', fieldBias],
        ] as const) {
          const module = (await recorder.backend.createShaderModule(device, { code })).unwrap();
          const kernel = (
            await createIrradianceFieldKernel(device, 'cardSurface', module, 'ray-query')
          ).unwrap();
          for (const mode of [
            'directional-close',
            'point-close',
            'point-clear',
            'directional-unresolved-only',
          ] as const) {
            for (const bias of [0.2, 0.0001]) {
              lf.fill(0);
              const directional = mode.startsWith('directional');
              lf[3] = directional ? 1 : 2;
              lf.set([1, 1, 1, 0], 4);
              cf[0] = mode === 'directional-unresolved-only' ? 4 : directional ? -1 : -0.05;
              cf[1] = directional ? -1 : -0.05;
              cf[2] = mode === 'point-clear' ? 0.2 : 0;
              cf[7] = directional ? 2 : 0.1;
              cf[11] = directional ? 2 : 0.1;
              if (directional) lf.set([0, 0, -1, 0], 8);
              else lf.set([0, 0, mode === 'point-clear' ? 0.3 : 0.1], 0);
              device.queue.writeBuffer(lights, 0, lightBytes).unwrap();
              device.queue.writeBuffer(cards, 0, cardBytes).unwrap();
              device.queue
                .writeBuffer(
                  frame,
                  0,
                  packIrradianceFieldFrame({
                    worldSource: { traversal: 'ray-query' },
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
                mode === 'point-clear' || (shader === 'field-bias-falsifier' && bias === 0.2)
                  ? 1
                  : 0;
              const expectedValid = mode === 'directional-unresolved-only' && !expectedMask ? 0 : 1;
              const row: (typeof controls)[number] = {
                shader,
                mode,
                bias,
                expectedMask,
                masks: [],
                expectedValid,
                validity: [],
              };
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
                const bytes = await readBuffer(
                  device,
                  surfaces,
                  4 * IRRADIANCE_FIELD_SURFACE_BYTES,
                );
                const view = new DataView(bytes.buffer);
                row.masks.push(
                  Array.from({ length: 4 }, (_, i) =>
                    view.getUint32(i * IRRADIANCE_FIELD_SURFACE_BYTES + 12, true),
                  ),
                );
                row.validity.push(
                  Array.from({ length: 4 }, (_, i) =>
                    view.getUint32(i * IRRADIANCE_FIELD_SURFACE_BYTES + 28, true),
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
              expect(
                row.validity.every((valid) => valid.every((value) => value === expectedValid)),
              ).toBe(true);
            }
          }
        }
      };
      await compareCardVisibility();

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
