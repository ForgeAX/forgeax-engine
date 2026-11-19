import { createHash } from 'node:crypto';
import {
  buildMeshDistanceField,
  createBoxGeometry,
  encodeMeshDistanceField,
  MESH_GEOMETRIC_DISTANCE_FIELD_CODEC,
} from '@forgeax/engine-geometry';
import { PhysicsWorldResource } from '@forgeax/engine-physics';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { WaterShallowCollider } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { afterAll, beforeAll, bench, vi } from 'vitest';
import { MeshFilter } from '../components/mesh-filter';
import {
  createRenderFeatureGpuWorkOwner,
  type RenderFeatureGpuPrepareSession,
} from '../features/prepared-gpu-work';
import { SdfFieldUpload } from '../raytracing/sdf-field-storage';
import { createSceneDataCatalog } from '../temporal/scene-data-catalog';
import { createWaterAdvancedFeature } from '../water/advanced-feature';
import { advancedPhysicsFixture, advancedWaterFixture } from './advanced-water-fixture';

const options = { time: 500, warmupTime: 100, warmupIterations: 4 };
let fixture: Awaited<ReturnType<typeof advancedWaterFixture>>;
let device: RhiDevice;
let feature: ReturnType<typeof createWaterAdvancedFeature>;
let gpu: ReturnType<typeof createRenderFeatureGpuWorkOwner>;
let session: RenderFeatureGpuPrepareSession;
let updateCount = 1;
let prepared = false;
let payloadByteLength = 0;
let physicalFieldBufferBytes = 0;
let queueWriteCount = 0;
let queueWriteBytes = 0;
let fieldQueueWriteCount = 0;
let fieldQueueWriteBytes = 0;
let fieldBufferSet: WeakSet<object>;
let captureCalls: number;
let uploadCopies: number;
let warmBaseline = {
  captures: 0,
  copies: 0,
  fieldWrites: 0,
  fieldBytes: 0,
  queueWrites: 0,
  queueBytes: 0,
};
let captureSpy: ReturnType<typeof vi.spyOn>;
let copySpy: ReturnType<typeof vi.spyOn>;
let createBufferSpy: ReturnType<typeof vi.spyOn>;
let writeBufferSpy: ReturnType<typeof vi.spyOn>;

async function setupField(): Promise<void> {
  const geometry = createBoxGeometry(2, 2, 2).unwrap();
  if (geometry.indices === undefined) throw new Error('SDF benchmark requires indexed geometry');
  const field = (
    await buildMeshDistanceField(geometry.attributes.position as Float32Array, geometry.indices, {
      resolution: 48,
    })
  ).unwrap();
  const encoded = (await encodeMeshDistanceField(field)).unwrap();
  const digest = createHash('sha256').update(encoded).digest('hex');
  const handle = fixture.assets
    .create({
      ...geometry,
      distanceField: {
        ...field,
        sectionSidedness: geometry.submeshes.map(() => 0 as const),
        artifact: {
          integrity: { algorithm: 'sha256' as const, digest: `sha256:${digest}` },
          assetCodec: { ...MESH_GEOMETRIC_DISTANCE_FIELD_CODEC },
        },
      },
    })
    .unwrap();
  const entity = fixture.world
    .spawn(
      { component: WaterShallowCollider, data: { enabled: true } },
      { component: MeshFilter, data: { assetHandle: handle } },
    )
    .unwrap();
  fixture.world.insertResource(
    PhysicsWorldResource,
    advancedPhysicsFixture({
      getCommittedColliderPrimitives: () =>
        ok({
          entity,
          generation: 1,
          completedStep: updateCount,
          motionDiscontinuity: 0,
          positionM: [10, 6, 20],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
          centerOfMassM: [10, 6, 20],
          linearVelocityMps: [0, 0, 0],
          angularVelocityRadps: [0, 0, 0],
          rawAggregateCount: 0,
          elements: [],
        }),
      intersectsCommittedBodyObb: () => ok(true),
    }),
  );
}

async function capturePlanAndPrepare(): Promise<void> {
  fixture.update(++updateCount / 60);
  const extraction = feature.extract({
    ...fixture.context,
    frameNumber: updateCount,
  });
  if (!extraction.ok) throw extraction.error;
  const plan = feature.plan(extraction.value, {
    caps: {
      ...device.caps,
      compute: true,
      storageBuffer: true,
      storageTexture: true,
      rgba16floatStorage: true,
      rgba32floatStorage: true,
    },
    limits: { maxTextureDimension2D: 8192 },
    frame: { frameNumber: updateCount },
    generation: 0,
    deviceGeneration: 0,
    views: [
      {
        identity: 'main',
        render: true,
        frame: { frameNumber: updateCount },
        targets: [],
        sceneData: createSceneDataCatalog({
          featureIdentity: feature.identity,
          viewIdentity: 'main',
          generation: 0,
          deviceGeneration: 0,
          planIdentity: `sdf-owner-bench:${updateCount}`,
          rgba16floatRenderable: true,
        }),
      },
    ],
  });
  if (!plan.ok) throw plan.error;
  if ('pendingSource' in plan.value) throw new Error('SDF source unexpectedly remained pending');
  const resources = plan.value.work.flatMap((work) => work.resources);
  const field = resources.find(
    (resource) => resource.kind === 'buffer' && resource.name.endsWith('-rigid-sdf-fields'),
  );
  const dynamic = resources.filter(
    (resource) =>
      resource.kind === 'buffer' &&
      (resource.name.endsWith('-rigid-primitives') ||
        resource.name.endsWith('-rigid-sdf-instances')),
  );
  if (field?.kind !== 'buffer' || field.initialization === undefined || dynamic.length !== 2)
    throw new Error('Expected initialized fields plus dynamic primitive and instance resources');
  payloadByteLength = field.initialization.byteLength;

  if (prepared) session.beginFrame();
  for (const resource of [...dynamic, field]) {
    if (resource.kind !== 'buffer') continue;
    const reference = session.prepareBuffer(resource.name, resource).unwrap();
    if (resource === field) {
      const physical = session.resolveBuffer(reference);
      if (physical === undefined) throw new Error('Missing prepared physical SDF buffer');
      physicalFieldBufferBytes = physical.size;
    }
  }
  for (const lease of session.commitFrame()) lease.release().unwrap();
  prepared = true;
  const submission = {
    works: plan.value.work.map((work) => ({
      scope: work.scope,
      passes: work.passes.map((pass) => ({ name: pass.name })),
    })),
  };
  feature.onFrameSubmitted?.(extraction.value, submission);
  feature.onSourceFrameSubmitted?.(extraction.value, plan.value.sourceFeedback, submission);
}

beforeAll(async () => {
  fixture = await advancedWaterFixture({
    kind: 'distance-field',
    accurate: true,
    useWaterHeightForCollision: false,
    collisionGroups: 0xffff_ffff,
    collisionOffsetCells: 0,
    overlapThicknessCells: 1,
    softCollisionFalloffM: 0.3,
    maxElements: 100,
  });
  await setupField();
  const adapter = (await rhi.requestAdapter()).unwrap();
  device = (await adapter.requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'sdf owner benchmark' })).unwrap();
  gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  feature = createWaterAdvancedFeature({});
  session = gpu.beginFeature(feature.identity, 0);

  fieldBufferSet = new WeakSet<object>();
  const createBuffer = device.createBuffer.bind(device);
  createBufferSpy = vi.spyOn(device, 'createBuffer').mockImplementation((descriptor) => {
    const created = createBuffer(descriptor);
    if (created.ok && descriptor.label?.endsWith('-rigid-sdf-fields'))
      fieldBufferSet.add(created.value as object);
    return created;
  });
  const writeBuffer = device.queue.writeBuffer.bind(device.queue);
  writeBufferSpy = vi
    .spyOn(device.queue, 'writeBuffer')
    .mockImplementation((buffer, offset, data) => {
      const byteLength = ArrayBuffer.isView(data) ? data.byteLength : 0;
      queueWriteCount++;
      queueWriteBytes += byteLength;
      if (fieldBufferSet.has(buffer as object)) {
        fieldQueueWriteCount++;
        fieldQueueWriteBytes += byteLength;
      }
      return writeBuffer(buffer, offset, data);
    });
  captureSpy = vi.spyOn(SdfFieldUpload, 'capture');
  copySpy = vi.spyOn(SdfFieldUpload.prototype, 'copyInto');

  await capturePlanAndPrepare();
  captureCalls = captureSpy.mock.calls.length;
  uploadCopies = copySpy.mock.calls.length;
  warmBaseline = {
    captures: captureCalls,
    copies: uploadCopies,
    fieldWrites: fieldQueueWriteCount,
    fieldBytes: fieldQueueWriteBytes,
    queueWrites: queueWriteCount,
    queueBytes: queueWriteBytes,
  };
});

bench(
  'SDF owner capture → history → plan → physical buffer prepare (48³)',
  async () => {
    await capturePlanAndPrepare();
  },
  options,
);

afterAll(() => {
  const warm = {
    assetCaptures: captureSpy.mock.calls.length - warmBaseline.captures,
    copies: copySpy.mock.calls.length - warmBaseline.copies,
    fieldWrites: fieldQueueWriteCount - warmBaseline.fieldWrites,
    fieldBytes: fieldQueueWriteBytes - warmBaseline.fieldBytes,
    queueWrites: queueWriteCount - warmBaseline.queueWrites,
    queueBytes: queueWriteBytes - warmBaseline.queueBytes,
  };
  const coldFieldCopyBytes = payloadByteLength * (captureCalls + uploadCopies);
  process.stdout.write(
    `SDF owner counters: field payload ${payloadByteLength} B; cold CPU field copies ${coldFieldCopyBytes} B ` +
      `(${captureCalls} asset capture + ${uploadCopies} initialization copy), cold field seed ${warmBaseline.fieldWrites} ` +
      `queue write / ${warmBaseline.fieldBytes} B; warm frames ${warm.assetCaptures} new asset captures, ` +
      `${warm.copies * payloadByteLength} B static CPU copies, ${warm.fieldWrites} field writes / ${warm.fieldBytes} B ` +
      `and ${warm.queueWrites} total writes / ${warm.queueBytes} B; retained storage ` +
      `${payloadByteLength} B CPU + ${physicalFieldBufferBytes} B GPU.\n`,
  );
  captureSpy.mockRestore();
  copySpy.mockRestore();
  createBufferSpy.mockRestore();
  writeBufferSpy.mockRestore();
  gpu.dispose().unwrap();
  fixture.assets.dispose();
});
