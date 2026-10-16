import { mkdirSync, writeFileSync } from 'node:fs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RAY_QUERY_FEATURE, type RhiCommandEncoder, type Tlas } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GlobalSdfQueryStatus } from '../../raytracing/global-sdf-query';
import {
  IRRADIANCE_FIELD_PENDING_OFFSET,
  IRRADIANCE_FIELD_UNIFORM_BYTES,
} from '../../raytracing/irradiance-field';
import { addWorldAccelerationPass } from '../../raytracing/irradiance-field-graph';
import { kernelGraphAccess, resolveKernelBinding } from '../../raytracing/kernel-graph-access';
import { prepareWorldAcceleration } from '../../raytracing/renderer-world-acceleration';
import { createWorldAcceleration } from '../../raytracing/world-acceleration';
import { WORLD_TRAVERSAL_ROSTER, worldTraversalWgsl } from '../../raytracing/world-traversal';
import { readBuffer } from './path-tracer.fixture';

// Dawn has no native Ray Query extension. The native workflow runs this gate
// explicitly; a native device without the feature is a failure, never a skip.
it.skipIf(process.env.FORGEAX_WEBGPU_NODE !== 'wgpu-native')(
  'rejects incomplete world traversal across budgeted builds, edits and failed-submit recovery',
  async () => {
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice({ requiredFeatures: [RAY_QUERY_FEATURE as GPUFeatureName] })
    ).unwrap();
    const raw = webgpu._internal_getRawDevice(device);
    if (!raw) throw new Error('native traversal support requires the real device');
    const errors: string[] = [];
    raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const transform = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
    const geometry = (geometryId: number) => ({
      geometryId,
      positions: new Float32Array([-1, -1, -2, 1, -1, -2, 0, 1, -2]),
    });
    const instance = (id: number, x: number) => ({
      instanceId: id,
      geometryId: id,
      mask: 255,
      transform: transform(x),
    });
    const instances = Array.from({ length: 5 }, (_, i) => instance(i, i === 4 ? 0 : 20));
    const lane = prepareWorldAcceleration(
      device,
      { instances },
      instances.map((i) => geometry(i.geometryId)),
      { instances: 10, triangles: 5 },
    ).unwrap();
    const output = device.createBuffer({ size: 768, usage: 128 | 4 }).unwrap();
    // The first ray crosses only the fifth, initially absent mesh; the second
    // hits resident geometry; the third misses a complete scene. The fourth
    // starts 5 cm from the same blocker: a 20 cm field bias skips it.
    const rays = device.createBuffer({ size: 4 * 48, usage: 128 | 8 }).unwrap();
    const data = new ArrayBuffer(4 * 48);
    const f = new Float32Array(data),
      u = new Uint32Array(data);
    for (const [i, x] of [0, 20, 40, 0].entries()) {
      f.set([x, 0, i === 3 ? -1.95 : 0, 0, 0, 0, -1, 4], i * 12);
      u[i * 12 + 8] = 255;
    }
    device.queue.writeBuffer(rays, 0, new Uint8Array(data)).unwrap();
    const source = worldTraversalWgsl('ray-query');
    const coverageGuard = ` if(traversalInstances[0].x!=0u){result.state.x=${GlobalSdfQueryStatus.missingField}u;return result;}`;
    expect(source.split(coverageGuard)).toHaveLength(2);
    // FALSIFY: the same real scene with only its coverage rejection removed.
    // Partial TLAS hits and misses must disagree with the complete-world contract.
    const precisionOrigin = 'return position + normal * bias;';
    expect(source.split(precisionOrigin)).toHaveLength(2);
    // FALSIFY: the old field-sized origin skips the nearby fourth-ray blocker.
    const modules = [];
    for (const code of [
      source,
      source.replace(coverageGuard, ''),
      source.replace(precisionOrigin, 'return position + normal * fieldBias;'),
    ]) {
      modules.push(
        (
          await webgpu.createShaderModule(device, {
            code: `${code}
@group(0) @binding(7) var<storage,read> rays: array<Ray>;
@group(0) @binding(8) var<storage,read_write> hits: array<Hit>;
@compute @workgroup_size(1) fn verifyWorldSupport(@builtin(global_invocation_id) id:vec3u) {
  if(id.x<arrayLength(&rays)){
    let ray=rays[id.x];
    let origin=worldSurfaceOrigin(ray.origin,vec3f(0,0,-1),0.2);
    hits[id.x]=traceWorld(Ray(origin,ray.tMin,ray.direction,ray.tMax,ray.mask),256u,1.0);
  }
}`,
          })
        ).unwrap(),
      );
    }
    const roster = WORLD_TRAVERSAL_ROSTER['ray-query'];
    const layout = device
      .createBindGroupLayout({
        entries: [
          ...roster.map(([binding, kind]) =>
            kind === 'tlas'
              ? { binding, visibility: 4, accelerationStructure: {} }
              : { binding, visibility: 4, buffer: { type: 'read-only-storage' as const } },
          ),
          { binding: 7, visibility: 4, buffer: { type: 'read-only-storage' } },
          { binding: 8, visibility: 4, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
    const pipelines = modules.map((module) =>
      device
        .createComputePipeline({
          layout: pipelineLayout,
          compute: { module, entryPoint: 'verifyWorldSupport' },
        })
        .unwrap(),
    );
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const field = device
      .createBuffer({ size: IRRADIANCE_FIELD_UNIFORM_BYTES, usage: 64 | 12 })
      .unwrap();
    const fieldHandle = graph
      .importBuffer(
        'support.field',
        { size: IRRADIANCE_FIELD_UNIFORM_BYTES, usage: 64 | 12 },
        () => field,
      )
      .unwrap();
    const world = addWorldAccelerationPass(graph, lane, () => lane, fieldHandle).unwrap();
    const worldHandle = (name: keyof typeof world) => {
      const handle = world[name];
      if (handle === undefined) throw new Error(`missing native world ${name}`);
      return handle;
    };
    const destination = graph
      .importBuffer('support.hits', { size: 768, usage: 128 | 4 }, () => output)
      .unwrap();
    const input = graph
      .importBuffer('support.rays', { size: 4 * 48, usage: 128 | 8 }, () => rays)
      .unwrap();
    graph
      .addComputePass('support.trace', {
        accesses: [
          ...roster.map(([, kind, name]) =>
            kernelGraphAccess(kind, worldHandle(name as keyof typeof world), 'storage-write'),
          ),
          { resource: input, usage: 'storage-read' },
          { resource: destination, usage: 'storage-write' },
        ],
        encode: ({ pass, resources }) => {
          for (const [control, pipeline] of pipelines.entries()) {
            const group = device
              .createBindGroup({
                layout,
                entries: [
                  ...roster.map(([binding, kind, name]) => ({
                    binding,
                    resource:
                      kind === 'tlas'
                        ? {
                            kind: 'accelerationStructure' as const,
                            value: resolveKernelBinding(
                              resources,
                              kind,
                              worldHandle(name as keyof typeof world),
                            ) as Tlas,
                          }
                        : {
                            kind: 'buffer' as const,
                            value: resolveKernelBinding(
                              resources,
                              kind,
                              worldHandle(name as keyof typeof world),
                            ) as { buffer: typeof output },
                          },
                  })),
                  {
                    binding: 7,
                    resource: {
                      kind: 'buffer',
                      value: { buffer: resources.buffer(input).unwrap() },
                    },
                  },
                  {
                    binding: 8,
                    resource: {
                      kind: 'buffer',
                      value: {
                        buffer: resources.buffer(destination).unwrap(),
                        offset: control * 256,
                        size: 4 * 64,
                      },
                    },
                  },
                ],
              })
              .unwrap();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(4);
          }
        },
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const result: {
      status: string;
      frames: {
        name: string;
        states: number[];
        withoutCoverageGuard: number[];
        withFieldSizedOrigin: number[];
        instances: number[];
        pending: number;
        sampledPending: number;
      }[];
      errors: string[];
      failure?: string;
    } = { status: 'running', frames: [], errors };
    const frame = async (name: string, expected: number[]) => {
      const encoder = device.createCommandEncoder({}).unwrap();
      compiled.execute({ encoder }).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      lane.track(device.queue.onSubmittedWorkDone());
      lane.commit();
      const bytes = await readBuffer(device, output, 768),
        words = new DataView(bytes.buffer);
      const states = [0, 1, 2, 3].map((i) => words.getUint32(i * 64, true));
      const withoutCoverageGuard = [0, 1, 2, 3].map((i) => words.getUint32(256 + i * 64, true));
      const withFieldSizedOrigin = [0, 1, 2, 3].map((i) => words.getUint32(512 + i * 64, true));
      const uniform = await readBuffer(device, field, IRRADIANCE_FIELD_UNIFORM_BYTES);
      const sampledPending = new DataView(uniform.buffer).getUint32(
        IRRADIANCE_FIELD_PENDING_OFFSET,
        true,
      );
      result.frames.push({
        name,
        states,
        withoutCoverageGuard,
        withFieldSizedOrigin,
        instances: [0, 1, 2, 3].map((i) => words.getUint32(i * 64 + 12, true)),
        pending: lane.inspect().pending,
        sampledPending,
      });
      expect(states, name).toEqual(expected);
      if (lane.inspect().pending > 0) {
        expect(withoutCoverageGuard, `${name}:FALSIFY partial world`).toEqual([
          GlobalSdfQueryStatus.miss,
          GlobalSdfQueryStatus.hit,
          GlobalSdfQueryStatus.miss,
          GlobalSdfQueryStatus.miss,
        ]);
        expect(withoutCoverageGuard, `${name}:FALSIFY must reject`).not.toEqual(states);
      } else {
        expect(withoutCoverageGuard, `${name}:complete world control`).toEqual(states);
      }
      if (lane.inspect().pending === 0 && states[3] === GlobalSdfQueryStatus.hit) {
        expect(withFieldSizedOrigin[3], `${name}:FALSIFY field bias skips near blocker`).toBe(
          GlobalSdfQueryStatus.miss,
        );
        expect(withFieldSizedOrigin.slice(0, 3), `${name}:unchanged original rays`).toEqual(
          states.slice(0, 3),
        );
      } else {
        expect(withFieldSizedOrigin, `${name}:origin control without a resident blocker`).toEqual(
          states,
        );
      }
      expect(sampledPending, `${name}:shared sampler coverage`).toBe(lane.inspect().pending);
    };
    const missing = Array(4).fill(GlobalSdfQueryStatus.missingField);
    const complete = [
      GlobalSdfQueryStatus.hit,
      GlobalSdfQueryStatus.hit,
      GlobalSdfQueryStatus.miss,
      GlobalSdfQueryStatus.hit,
    ];
    try {
      await frame('cold-budget', missing);
      await frame('cold-complete', complete);
      expect(result.frames[1]?.instances[0]).toBe(4);
      lane.edit({ moved: [{ index: 4, to: transform(20) }], removed: [], added: [] }).unwrap();
      await frame('moved-blocker', [
        GlobalSdfQueryStatus.miss,
        GlobalSdfQueryStatus.hit,
        GlobalSdfQueryStatus.miss,
        GlobalSdfQueryStatus.miss,
      ]);
      lane
        .edit({
          moved: [],
          removed: [],
          added: Array.from({ length: 5 }, (_, i) => ({
            instance: instance(i + 5, i === 4 ? 0 : 20),
            geometry: geometry(i + 5),
          })),
        })
        .unwrap();
      await frame('added-budget', missing);
      const old = lane.current().tlas;
      // Encode the completion but abandon it before submit or commit.
      compiled.execute({ encoder: device.createCommandEncoder({}).unwrap() }).unwrap();
      await frame('failed-submit-recovery', missing);
      expect(lane.current().tlas).not.toBe(old);
      await frame('recovery-budget', missing);
      await frame('recovery-complete', complete);
      expect(result.frames.at(-1)?.instances[0]).toBe(9);
      lane.edit({ moved: [], removed: [{ index: 9 }], added: [] }).unwrap();
      await frame('removed-blocker', [
        GlobalSdfQueryStatus.miss,
        GlobalSdfQueryStatus.hit,
        GlobalSdfQueryStatus.miss,
        GlobalSdfQueryStatus.miss,
      ]);
      expect(errors).toEqual([]);
      result.status = 'pass';
    } catch (cause) {
      result.status = 'fail';
      result.failure = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      const directory = 'artifacts/irradiance-field/native-world-support';
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${directory}/result.json`, JSON.stringify(result, null, 2));
      await compiled.retire();
      lane.dispose();
      device.destroyBuffer(rays).unwrap();
      device.destroyBuffer(output).unwrap();
      device.destroyBuffer(field).unwrap();
      raw.destroy();
    }
  },
  120000,
);

// Closest-hit identity is unspecified for exact coincident opposite windings.
// Force each valid tied face through the production normal table, while the
// ordinary back and separated-plane controls keep their original orientation.
it.skipIf(process.env.FORGEAX_WEBGPU_NODE !== 'wgpu-native')(
  'keeps opposite-winding coverage independent of tied face choice without flipping ordinary backs',
  async () => {
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice({ requiredFeatures: [RAY_QUERY_FEATURE as GPUFeatureName] })
    ).unwrap();
    const raw = webgpu._internal_getRawDevice(device);
    if (!raw) throw new Error('coincident surface gate requires a real native device');
    const errors: string[] = [];
    raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
    const separate = new Float32Array([...positions, ...positions]);
    for (let i = 3; i < 6; i++) separate[i * 3 + 2] = 0.001;
    const geometries = [
      { geometryId: 0, positions, indices: new Uint32Array([0, 1, 2, 2, 1, 0]) },
      { geometryId: 1, positions, indices: new Uint32Array([0, 1, 2]) },
      { geometryId: 2, positions: separate, indices: new Uint32Array([0, 1, 2, 5, 4, 3]) },
    ];
    const transform = (x: number, mirror = false) => [
      2,
      0,
      0,
      0,
      0,
      3,
      0,
      0,
      0,
      0,
      mirror ? -0.5 : 0.5,
      0,
      x,
      0,
      0,
      1,
    ];
    const instances = [0, 1, 2, 0].map((geometryId, index) => ({
      geometryId,
      instanceId: index + 7,
      mask: 255,
      transform: transform(index * 4, index === 3),
    }));
    const world = createWorldAcceleration(device, {
      maxInstances: 4,
      maxTriangles: 5,
      maxBlasBuildsPerFrame: 3,
    }).unwrap();
    const input = device.createBuffer({ size: 8 * 48, usage: 128 | 8 }).unwrap();
    const output = device.createBuffer({ size: 4 * 8 * 64, usage: 128 | 4 }).unwrap();
    const rays = new DataView(new ArrayBuffer(8 * 48));
    for (let i = 0; i < 8; i++) {
      const originZ = i % 2 === 0 ? 1 : -1;
      rays.setFloat32(i * 48, Math.floor(i / 2) * 4, true);
      rays.setFloat32(i * 48 + 8, originZ, true);
      rays.setFloat32(i * 48 + 12, 1e-4, true);
      rays.setFloat32(i * 48 + 24, -originZ, true);
      rays.setFloat32(i * 48 + 28, 4, true);
      rays.setUint32(i * 48 + 32, 255, true);
    }
    device.queue.writeBuffer(input, 0, rays.buffer).unwrap();
    const source = worldTraversalWgsl('ray-query');
    const selection = 'faceNormals[row.y+c.primitive_index]';
    expect(source.split(selection)).toHaveLength(2);
    const forced = [0, 1].map((face) =>
      source.replace(
        selection,
        `faceNormals[row.y+select(c.primitive_index,${face}u,row.x==7u||row.x==10u)]`,
      ),
    );
    const firstForced = forced[0];
    if (firstForced === undefined) throw new Error('missing tied-face negative control');
    expect(firstForced.split('face.w!=0.0&&')).toHaveLength(2);
    const codes = [source, ...forced, firstForced.replace('face.w!=0.0&&', 'false&&')];
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, accelerationStructure: {} },
          { binding: 2, visibility: 4, buffer: { type: 'read-only-storage' } },
          { binding: 3, visibility: 4, buffer: { type: 'read-only-storage' } },
          { binding: 7, visibility: 4, buffer: { type: 'read-only-storage' } },
          { binding: 8, visibility: 4, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
    const result: { adapter: unknown; status: string; rows: number[][]; errors: string[] } = {
      adapter: raw.adapterInfo,
      status: 'running',
      rows: [],
      errors,
    };
    try {
      const pipelines = [];
      for (const code of codes) {
        const module = (
          await webgpu.createShaderModule(device, {
            code: `${code}
@group(0) @binding(7) var<storage,read> rays: array<Ray>;
@group(0) @binding(8) var<storage,read_write> hits: array<Hit>;
@compute @workgroup_size(1) fn verifyCoincidentSurface(@builtin(global_invocation_id) id:vec3u) {
 if(id.x<arrayLength(&rays)){hits[id.x]=traceWorld(rays[id.x],256u,1.0);}
}`,
          })
        ).unwrap();
        pipelines.push(
          device
            .createComputePipeline({
              layout: pipelineLayout,
              compute: { module, entryPoint: 'verifyCoincidentSurface' },
            })
            .unwrap(),
        );
      }
      const encoder = device.createCommandEncoder({}).unwrap();
      expect(world.update(encoder, geometries, instances).unwrap().pending).toBe(0);
      const pass = encoder.beginComputePass({});
      for (const [variant, pipeline] of pipelines.entries()) {
        const group = device
          .createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { kind: 'accelerationStructure', value: world.tlas } },
              {
                binding: 2,
                resource: { kind: 'buffer', value: { buffer: world.traversalInstances } },
              },
              { binding: 3, resource: { kind: 'buffer', value: { buffer: world.faceNormals } } },
              { binding: 7, resource: { kind: 'buffer', value: { buffer: input } } },
              {
                binding: 8,
                resource: {
                  kind: 'buffer',
                  value: { buffer: output, offset: variant * 512, size: 512 },
                },
              },
            ],
          })
          .unwrap();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(8);
      }
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const bytes = await readBuffer(device, output, 2048);
      const words = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let variant = 0; variant < 4; variant++) {
        const dots: number[] = [];
        for (let ray = 0; ray < 8; ray++) {
          const base = variant * 512 + ray * 64;
          expect(words.getUint32(base, true), `${variant}:${ray}:actual hit`).toBe(
            GlobalSdfQueryStatus.hit,
          );
          const directionZ = ray % 2 === 0 ? -1 : 1;
          dots.push(words.getFloat32(base + 56, true) * directionZ);
          expect(
            words.getFloat32(base + 16, true),
            `${variant}:${ray}:near plane preserved`,
          ).toBeCloseTo(ray === 4 ? 0.9995 : 1, 5);
        }
        result.rows.push(dots);
      }
      for (const [variant, dots] of result.rows.slice(0, 3).entries()) {
        for (const ray of [0, 1, 6, 7])
          expect(dots[ray], `${variant}:${ray}:paired coverage`).toBeLessThan(-0.99);
        expect(dots[2], `${variant}:ordinary front`).toBeLessThan(-0.99);
        for (const ray of [3, 4, 5])
          expect(dots[ray], `${variant}:${ray}:ordinary back retained`).toBeGreaterThan(0.99);
      }
      expect(
        result.rows[3]?.[1],
        'FALSIFY tied back when coverage orientation is removed',
      ).toBeGreaterThan(0.99);
      expect(result.rows[3]).not.toEqual(result.rows[1]);
      expect(errors).toEqual([]);
      result.status = 'pass';
      const directory = 'artifacts/irradiance-field/native-coincident-surface';
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${directory}/hits.bin`, bytes);
    } catch (cause) {
      result.status = 'fail';
      throw cause;
    } finally {
      const directory = 'artifacts/irradiance-field/native-coincident-surface';
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${directory}/result.json`, JSON.stringify(result, null, 2));
      world.dispose();
      device.destroyBuffer(input).unwrap();
      device.destroyBuffer(output).unwrap();
      raw.destroy();
    }
  },
  120000,
);
