import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import type { Buffer, Result, RhiError } from '@forgeax/engine-rhi';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { Instances, MeshFilter, MeshRenderer } from '../components';
import { InstanceProjectionStore } from '../instances';
import { extractFrames } from '../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../scene/render-scene';

class CountingQueue extends RhiNullQueue {
  bytes = 0;

  override writeBuffer(
    buffer: Buffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): Result<void, RhiError> {
    this.bytes += size ?? data.byteLength - (dataOffset ?? 0);
    return super.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
  }
}

function grid(count: number): Float32Array {
  const transforms = new Float32Array(count * 16);
  for (let row = 0; row < count; row += 1) {
    const offset = row * 16;
    transforms[offset] = 1;
    transforms[offset + 5] = 1;
    transforms[offset + 10] = 1;
    transforms[offset + 15] = 1;
    transforms[offset + 12] = (row % 256) * 2;
    transforms[offset + 14] = Math.floor(row / 256) * 2;
  }
  return transforms;
}

/** Cumulative work counters of the ECS -> RenderScene -> GpuScene Instances path. */
export interface InstanceRowWork {
  readonly projectionRows: number;
  readonly fullProjections: number;
  readonly boundsNodeVisits: number;
  readonly boundsDerives: number;
  readonly gpuSceneRows: number;
  readonly uploadBytes: number;
}

export interface InstanceRowHarness {
  /** Write one instance row through `World.setArrayRange` and extract a frame. */
  move(row: number, x: number): void;
  /** Rewrite the whole column through `World.set` and extract a frame. */
  rewrite(row: number, x: number): void;
  work(): InstanceRowWork;
  dispose(): void;
}

/**
 * One Instances entity of `count` rows driven through the real extract,
 * PersistentRenderScene and GpuScene path on the null RHI.
 */
export function createInstanceRowHarness(count: number): InstanceRowHarness {
  const world = new World();
  registerPropagateTransforms(world);
  const materialHandle = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [1, 1, 1, 1] },
  });
  const transforms = grid(count);
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
      { component: Instances, data: { transforms } },
    )
    .unwrap();
  world.update(0).unwrap();
  const queue = new CountingQueue();
  const device = new RhiNullDevice(
    queue,
    (bookkeeper, owner) => new RhiNullCommandEncoder(bookkeeper, owner),
  );
  const instanceCollections = new InstanceProjectionStore();
  const scene = new PersistentRenderScene({ getDevice: () => device, instanceCollections });
  const lease = createRenderReadLease(world);
  const owner = { cameraOwner: 0, resourceOwner: 0 } as const;
  const build = (request: PersistentRenderCandidateRequest) =>
    extractFrames([world], owner, undefined, undefined, undefined, {
      cull: 'none',
      retainHidden: true,
      renderables: request,
      instanceCollections,
    });
  const extract = () => {
    world.update(0).unwrap();
    scene.extractComposition([world], owner, 0, build, [lease]);
  };
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1]);
  scene.extractComposition([world], owner, 0, build, [lease]);
  return {
    move(row, x) {
      matrix[12] = x;
      world.setArrayRange(entity, Instances, 'transforms', row * 16, matrix).unwrap();
      extract();
    },
    rewrite(row, x) {
      transforms[row * 16 + 12] = x;
      world.set(entity, Instances, { transforms }).unwrap();
      extract();
    },
    work() {
      const projection = instanceCollections.inspectWork();
      const bounds = scene.inspect().instanceBoundsCache;
      const gpu = scene.compositionGpuDrivenState()?.scene.inspect();
      return {
        projectionRows: projection.rows,
        fullProjections: projection.fullProjections,
        boundsNodeVisits: bounds?.nodeVisits ?? 0,
        boundsDerives: bounds?.derives ?? 0,
        gpuSceneRows: gpu?.instanceRowsVisited ?? 0,
        uploadBytes: queue.bytes,
      };
    },
    dispose() {
      lease.dispose();
      scene.dispose();
      instanceCollections.dispose();
    },
  };
}
