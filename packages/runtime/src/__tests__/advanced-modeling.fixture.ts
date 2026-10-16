import { World } from '@forgeax/engine-ecs';
import {
  createExtrusionGeometry,
  createProfileSweepGeometry,
  type Vec2Point,
  type Vec3Point,
} from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  encodeTape,
  halfToFloat,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
  tapeDigest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { renderValue } from './standard-gbuffer-replay.fixture';

export type ModelingSave = (name: string, bytes: Uint8Array) => void | Promise<void>;
const contour: Vec2Point[] = [
  { x: -1.5, y: -1.5 },
  { x: 1.5, y: -1.5 },
  { x: 1.5, y: 1.5 },
  { x: -1.5, y: 1.5 },
];
const hole: Vec2Point[] = [
  { x: -0.65, y: -0.65 },
  { x: 0.65, y: -0.65 },
  { x: 0.65, y: 0.65 },
  { x: -0.65, y: 0.65 },
];
function floats(bytes: Uint8Array, width: number, height: number, stride: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: width * height * 4 }, (_, i) =>
    halfToFloat(view.getUint16(Math.floor(i / (width * 4)) * stride + (i % (width * 4)) * 2, true)),
  );
}
export async function verifyAdvancedModeling(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: ModelingSave,
  sampleFrames = 60,
) {
  const world = new World(),
    errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const material = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.08, 0.45, 0.8, 1], roughness: 0.32, metallic: 0.2 }),
  );
  const initial = createExtrusionGeometry(contour, 0.8, { holes: [hole] }).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -6] } },
      { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', initial) } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 30,
          antialias: 0,
          bloom: 0,
          tonemap: 1,
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0.4, -0.6, -1], intensity: 4, castShadow: false },
    })
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const profile = renderer.inspect().profile;
  renderValue(renderer.setProfile({ ...profile, renderPath: 'deferred', ssao: false }));
  const path = Array.from(
    { length: 65 },
    (_, i): Vec3Point => [
      1.2 * Math.sin((i / 64) * Math.PI * 1.5),
      (i / 64 - 0.5) * 2.6,
      0.45 * Math.cos((i / 64) * Math.PI * 1.5),
    ],
  );
  const section: Vec2Point[] = [
    { x: -0.25, y: -0.22 },
    { x: 0.25, y: -0.22 },
    { x: 0.25, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0.22 },
    { x: -0.25, y: 0.22 },
  ];
  const cases = [
    { name: 'holes', mesh: initial, rotation: 0 },
    {
      name: 'concave-holes',
      mesh: createExtrusionGeometry(
        [
          { x: -1.5, y: -1.5 },
          { x: 1.5, y: -1.5 },
          { x: 1.5, y: 1.5 },
          { x: 0.5, y: 1.5 },
          { x: 0.5, y: 0.3 },
          { x: -0.5, y: 0.3 },
          { x: -0.5, y: 1.5 },
          { x: -1.5, y: 1.5 },
        ],
        0.8,
        {
          holes: [
            [
              { x: -1.2, y: -1.2 },
              { x: -0.5, y: -1.2 },
              { x: -0.5, y: -0.5 },
              { x: -1.2, y: -0.5 },
            ],
            [
              { x: 0.5, y: -1.2 },
              { x: 1.2, y: -1.2 },
              { x: 1.2, y: -0.5 },
              { x: 0.5, y: -0.5 },
            ],
          ],
          bevelSize: 0.08,
          bevelSegments: 3,
        },
      ).unwrap(),
      rotation: 0.3,
    },
    { name: 'solid-control', mesh: createExtrusionGeometry(contour, 0.8).unwrap(), rotation: 0 },
    {
      name: 'bevel',
      mesh: createExtrusionGeometry(contour, 0.8, {
        holes: [hole],
        bevelSize: 0.18,
        bevelSegments: 6,
      }).unwrap(),
      rotation: 0.5,
    },
    {
      name: 'profile-sweep',
      mesh: createProfileSweepGeometry({ contour: section }, path).unwrap(),
      rotation: 0.35,
    },
  ];
  const report: unknown[] = [],
    devices: GPUDevice[] = [];
  let holeCenter = 0;
  try {
    for (const item of cases) {
      world
        .set(entity, MeshFilter, { assetHandle: world.allocSharedRef('MeshAsset', item.mesh) })
        .unwrap();
      world
        .set(entity, Transform, {
          quat: [0, Math.sin(item.rotation / 2), 0, Math.cos(item.rotation / 2)],
        })
        .unwrap();
      const draw = async () => {
        world.update(1 / 60).unwrap();
        propagateTransforms(world).unwrap();
        const receipt = renderValue(
          renderer.draw({
            leases: [lease],
            camera: { lease },
            environment: { lease },
            geometryLane: 'direct',
          }),
        );
        renderValue(await receipt.completed);
        return receipt;
      };
      const times: number[] = [],
        gpu: number[] = [];
      let gpuStatus = 'unavailable';
      let gpuEvidence: unknown;
      for (let i = 0; i < sampleFrames; i++) {
        const start = performance.now();
        const receipt = await draw();
        if (i >= Math.floor(sampleFrames / 3)) {
          times.push(performance.now() - start);
          const timings = renderValue(
            await renderer.observe(receipt, { include: ['timings'] }),
          ).timings;
          if (timings) {
            gpuStatus = timings.status;
            gpuEvidence = timings;
            if (timings.status === 'complete' || timings.status === 'partial')
              gpu.push(timings.frame.measuredPassNanoseconds / 1e6);
          }
        }
      }
      if (!renderer.requestObservation) throw new Error('linear HDR observation unavailable');
      renderValue(renderer.requestObservation(['linear-hdr']));
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const receipt = await draw();
      (await recorder.frameBoundary()).unwrap();
      const captured = (await pending).unwrap();
      await save(`${item.name}.rhitape`, captured.bytes);
      const observed = renderValue(
        await renderer.observe(receipt, { include: ['linear-hdr'] }),
      ).observations?.find((v) => v.domain === 'linear-hdr');
      if (!observed) throw new Error('missing live HDR');
      const width = observed.metadata.width,
        height = observed.metadata.height;
      const live = floats(observed.bytes, width, height, observed.metadata.bytesPerRow);
      await save(`${item.name}.rgba16f`, observed.bytes);
      const tape = decodeTape(captured.bytes).unwrap(),
        model = buildFrameModel(tape);
      const geometry = model.works.find((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_gbuffer'),
      );
      const lighting = model.works.find((work) =>
        work.pipeline.shaders.some((shader) =>
          shader.entryPoint?.startsWith('fs_standard_deferred'),
        ),
      );
      if (!geometry || !lighting) throw new Error('missing geometry or lighting work');
      expect(geometry.drawCall).toMatchObject({
        kind: 'drawIndexed',
        indexCount: item.mesh.indices?.length,
      });
      expect(geometry.vertexBuffers.length).toBeGreaterThan(0);
      expect(geometry.indexBuffer).not.toBeNull();
      for (const id of [
        ...geometry.vertexBuffers.map((v) => v.bufferHandleId),
        geometry.indexBuffer?.bufferHandleId,
      ]) {
        const resource = tape.bootstrap.find((v) => v.handleId === id);
        expect(resource?.initialData.length).toBeGreaterThan(0);
      }
      const vertexBuffer = geometry.vertexBuffers[0];
      if (!vertexBuffer || !geometry.indexBuffer || !item.mesh.indices)
        throw new Error('missing mesh buffers');
      const uploadedBuffers: unknown[] = [];
      for (const [id, expected] of [
        [vertexBuffer.bufferHandleId, item.mesh.vertices],
        [geometry.indexBuffer.bufferHandleId, item.mesh.indices],
      ] as const) {
        const resource = tape.bootstrap.find((value) => value.handleId === id);
        expect(resource?.initialData).toHaveLength(1);
        const seed = resource?.initialData[0];
        const blob = tape.blobs.find((value) => value.hash === seed?.hash);
        if (!seed || !blob) throw new Error('missing captured mesh bytes');
        const bytes = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
        expect(blob.bytes.subarray(seed.byteOffset, seed.byteOffset + seed.byteLength)).toEqual(
          bytes,
        );
        uploadedBuffers.push({ resourceId: id, bytes: bytes.byteLength, digest: seed.hash });
      }
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
      ).unwrap();
      const native = device.nativeDevice().unwrap();
      devices.push(native);
      const gpuErrors: string[] = [];
      native.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
      native.pushErrorScope('validation');
      const replay = (
        await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      let delta = 0;
      try {
        // The model already identifies the geometry event. Its unconsumed
        // attachment added a separate prefix replay before the lighting oracle.
        const read = (await replay.inspectWork(lighting.workIndex, ['pixels'])).unwrap().attachment;
        if (!read) throw new Error('missing replay pixels');
        const replayValues = floats(read.bytes, width, height, width * 8);
        delta = live.reduce(
          (max, v, i) => Math.max(max, Math.abs(v - (replayValues[i] as number))),
          0,
        );
        expect(delta).toBeLessThanOrEqual(0.05);
        await save(`${item.name}-replay.rgba16f`, read.bytes);
      } finally {
        (await replay.dispose()).unwrap();
      }
      expect(await native.popErrorScope()).toBeNull();
      expect(gpuErrors).toEqual([]);
      const center = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
      const luminance =
        (live[center] as number) + (live[center + 1] as number) + (live[center + 2] as number);
      const occupied = live.filter((v, i) => i % 4 === 0 && v > 0.005).length;
      expect(occupied).toBeGreaterThan(width * height * 0.01);
      if (item.name === 'holes') {
        holeCenter = luminance;
        expect(luminance).toBeLessThan(0.005);
      }
      if (item.name === 'solid-control') expect(luminance - holeCenter).toBeGreaterThan(0.1);
      // A separately encoded missing-draw tape must lose the visible geometry.
      const missing = encodeTape({
        ...tape,
        events: tape.events.map((event, i) =>
          i === geometry.eventIndex && event.kind === 'drawIndexed'
            ? { ...event, indexCount: 0 }
            : event,
        ),
      }).unwrap();
      const bad = (
        await openReplay(decodeTape(missing).unwrap(), {
          device,
          createShaderModule: webgpu.createShaderModule,
        })
      ).unwrap();
      let falsifierDelta = 0;
      try {
        const read = (await bad.inspectWork(lighting.workIndex, ['pixels'])).unwrap().attachment;
        if (!read) throw new Error('missing falsifier pixels');
        const values = floats(read.bytes, width, height, width * 8);
        falsifierDelta = live.reduce(
          (max, v, i) => Math.max(max, Math.abs(v - (values[i] as number))),
          0,
        );
        expect(falsifierDelta).toBeGreaterThan(0.1);
      } finally {
        (await bad.dispose()).unwrap();
      }
      expect(gpuErrors).toEqual([]);
      times.sort((a, b) => a - b);
      gpu.sort((a, b) => a - b);
      report.push({
        name: item.name,
        width,
        height,
        completedFrames: 61,
        vertices: item.mesh.vertices.length / 12,
        triangles: (item.mesh.indices?.length ?? 0) / 3,
        tapeDigest: tapeDigest(captured.bytes),
        tapeBytes: captured.bytes.length,
        workIndex: geometry.workIndex,
        eventIndex: geometry.eventIndex,
        pipeline: geometry.pipeline.descriptor,
        vertexBuffers: geometry.vertexBuffers,
        indexBuffer: geometry.indexBuffer,
        unseededResources: model.unseededResources,
        liveReplayMaxDelta: delta,
        missingDrawMaxDelta: falsifierDelta,
        occupiedPixels: occupied,
        completedFrameCpuMs: { median: times[20], p95: times[38] },
        gpuErrors,
        uploadedBuffers,
        measuredGpuPassMs: {
          status: gpuStatus,
          lastObservation: gpuEvidence,
          samples: gpu.length,
          median: gpu[Math.floor(gpu.length / 2)],
          p95: gpu[Math.floor(gpu.length * 0.95)],
        },
      });
      await save(
        'report.json',
        new TextEncoder().encode(
          JSON.stringify({ backend: renderer.inspect().capabilities, cases: report }, null, 2),
        ),
      );
    }
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    renderValue(renderer.setProfile(profile));
    lease.dispose();
    for (const device of devices) device.destroy();
  }
}
