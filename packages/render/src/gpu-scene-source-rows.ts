import { MATERIAL_SCENE_ADDRESS_UNIT_BYTES, type MeshAsset } from '@forgeax/engine-types';
import type { GpuInputDescriptorReservation } from './gpu-input-arena';
import type { MaterialAllocation, MeshAllocation } from './gpu-scene';
import type { GpuSceneCapacityPreparation } from './gpu-scene-capacity';
import type { GpuSceneResourceReservation } from './gpu-scene-inputs';
import {
  encodeResetSceneTransform,
  encodeSceneInstance,
  encodeScenePrimitive,
} from './gpu-scene-row-encoding';
import { GPU_SCENE_LAYOUTS } from './gpu-scene-schema';
import type { MaterialResource } from './material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from './render-system-extract';
import { projectMeshDrawSnapshot } from './scene/mesh-draw';
import type { MeshGeometry } from './scene/mesh-frame';
import {
  type MeshMaterialBindingWrite,
  meshMaterialGeometry,
  prepareMeshMaterialBindings,
} from './scene/mesh-materials';
import type { ReservedSceneRow, SceneRowGeometry } from './scene/render-scene-types';
import type { StableRangeAllocator, StableRangeReservation } from './stable-range-allocator';

/** Private addresses of the actual Scene identity; no active map or resource binding is issued. */
export interface GpuSceneSourceRow extends SceneRowGeometry {
  readonly snapshot: RenderableSnapshot;
  readonly materialSlot: number;
  readonly meshSlot: number;
  readonly recordIndex: number;
  readonly instanceStart: number;
  readonly instanceCount: number;
  readonly transformStart: number;
  readonly instanceTransformStart: number;
}

export interface GpuSceneSourceMeshInput {
  readonly handle: number;
  readonly asset: MeshAsset;
  readonly identity: string;
  readonly revision: number;
}

export interface GpuSceneSourceResource {
  readonly logicalSlot: number;
  readonly descriptor: number;
  readonly privateDescriptor?: GpuInputDescriptorReservation | undefined;
  readonly mapping?: GpuSceneResourceReservation | undefined;
  isCurrent(): boolean;
  adopt(): void;
  release(): void;
}
export interface GpuSceneSourceMaterial extends GpuSceneSourceResource {
  readonly allocation: MaterialAllocation;
  readonly resource: MaterialResource;
  readonly snapshot: MaterialSnapshot;
  readonly payload?: { readonly start: number; readonly bytes: Uint8Array } | undefined;
}

export interface GpuSceneSourceMesh extends GpuSceneSourceResource {
  readonly allocation: MeshAllocation;
  readonly geometry: MeshGeometry;
}

const IDENTITY = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
const TRANSFORM = GPU_SCENE_LAYOUTS.transform.stride;
const INSTANCE = GPU_SCENE_LAYOUTS.instance.stride;

/** Source row detachments share the same bounded grant from CPU publication through GPU cleanup. */
export const SOURCE_ROWS_PER_RETIREMENT_STEP = 32;

/** Task-local custody over the issuing Scene's allocators; not another allocation authority. */
export class GpuSceneSourceRows {
  readonly rows: GpuSceneSourceRow[] = [];
  readonly extent = { primitive: 0, instance: 0, transform: 0, material: 0 };
  private readonly held: StableRangeReservation[] = [];
  readonly materials = new Map<MaterialResource, GpuSceneSourceMaterial>();
  readonly meshes = new Map<MeshGeometry, GpuSceneSourceMesh>();
  readonly bindings: MeshMaterialBindingWrite[] = [];
  readonly snapshots: RenderableSnapshot[] = [];
  private descriptorBytes = 0;
  private readonly geometries: MeshGeometry[] = [];

  constructor(
    private sources: readonly ReservedSceneRow[],
    private readonly allocators: {
      readonly primitive: StableRangeAllocator;
      readonly instance: StableRangeAllocator;
      readonly transform: StableRangeAllocator;
    },
    private readonly resources: {
      material(
        resource: MaterialResource,
        capture: (claim: GpuSceneSourceMaterial) => void,
      ): GpuSceneSourceMaterial;
      mesh(
        geometry: MeshGeometry,
        capture: (claim: GpuSceneSourceMesh) => void,
      ): GpuSceneSourceMesh;
    },
    readonly rowMaterialRanges: boolean,
  ) {}

  *prepareBindings(
    geometry: (handle: number) => MeshGeometry,
    current: () => boolean,
  ): Generator<void> {
    for (const source of this.sources) {
      if (!current()) throw new Error('Source material binding capture is not current');
      const snapshot = source.snapshot;
      const mesh = geometry(snapshot.assetHandle ?? 0);
      const effective = prepareMeshMaterialBindings(
        snapshot,
        mesh,
        meshMaterialGeometry(snapshot),
        (handle) => {
          const material = [snapshot.material, ...snapshot.materials].find(
            (value) => value.snapshot.materialHandle === handle,
          );
          if (material === undefined)
            throw new Error('Source binding has no fixed extracted material');
          return material;
        },
        this.bindings,
      );
      const projected = Object.freeze(projectMeshDrawSnapshot(snapshot, mesh, effective));
      this.snapshots.push(projected);
      this.geometries.push(mesh);
      yield;
    }
  }

  /** The ordinary standalone allocation also retains authored (possibly unused) slots. */
  *materialsFor(index: number): Generator<MaterialResource> {
    const projected = this.snapshots[index];
    if (projected === undefined) throw new Error('Source material projection is absent');
    yield* projected.materials.length === 0 ? [projected.material] : projected.materials;
    if (this.rowMaterialRanges) {
      const authored = this.sources[index]?.snapshot;
      if (authored === undefined) throw new Error('Source authored materials are absent');
      yield* authored.materials.length === 0 ? [authored.material] : authored.materials;
    }
  }

  resourcesCurrent(): boolean {
    for (const material of this.materials.values()) if (!material.isCurrent()) return false;
    for (const mesh of this.meshes.values()) if (!mesh.isCurrent()) return false;
    return true;
  }

  /** Input descriptors have transferred; these exact row ranges now belong to ordinary allocations. */
  acceptRanges(): void {
    for (const range of this.held) range.accept();
    this.held.length = 0;
  }

  get privateDescriptorBytes(): number {
    return this.descriptorBytes;
  }

  private reserveRange(kind: keyof GpuSceneSourceRows['allocators'], count: number): number {
    const range = this.allocators[kind].reserve(count);
    this.held.push(range);
    if (count > 0) this.extent[kind] = Math.max(this.extent[kind], range.start + count);
    return range.start;
  }

  *reserve(current: () => boolean, available: (slot: number) => boolean): Generator<void> {
    for (const [index, source] of this.sources.entries()) {
      if (!current()) throw new Error('Source row reservation is not current');
      if (!available(source.slot)) throw new Error('Source identity already has accepted GPU rows');
      const snapshot = this.snapshots[index];
      const geometry = this.geometries[index];
      if (snapshot === undefined || geometry === undefined)
        throw new Error('Source bindings were not captured');
      for (const resource of this.materialsFor(index)) {
        if (!this.materials.has(resource)) {
          let claim: GpuSceneSourceMaterial;
          try {
            claim = this.resources.material(resource, (captured) => {
              this.materials.set(resource, captured);
            });
          } finally {
            this.descriptorBytes +=
              (this.materials.get(resource)?.privateDescriptor?.wordCount ?? 0) * 4;
          }
          if (this.materials.get(resource) !== claim)
            throw new Error('Source material construction has no custody receipt');
          if (claim.payload !== undefined)
            this.extent.material = Math.max(
              this.extent.material,
              claim.payload.start +
                claim.payload.bytes.byteLength / MATERIAL_SCENE_ADDRESS_UNIT_BYTES,
            );
          yield;
        }
      }
      let mesh = this.meshes.get(geometry);
      if (mesh === undefined) {
        try {
          mesh = this.resources.mesh(geometry, (captured) => {
            this.meshes.set(geometry, captured);
          });
        } finally {
          this.descriptorBytes +=
            (this.meshes.get(geometry)?.privateDescriptor?.wordCount ?? 0) * 4;
        }
        if (mesh === undefined) throw new Error('Source Mesh construction has no custody receipt');
        yield;
      }
      const material = this.materials.get(snapshot.material);
      if (material === undefined) throw new Error('Source primary material was not reserved');
      const instances = snapshot.instances;
      const instanceCount = instances?.instanceCount ?? 1;
      if (!Number.isSafeInteger(instanceCount) || instanceCount < 0)
        throw new RangeError('Source instance count is not a bounded integer');
      this.rows.push(
        Object.freeze({
          source,
          snapshot,
          geometry,
          materialSlot: material.logicalSlot,
          meshSlot: mesh.logicalSlot,
          recordIndex: this.reserveRange('primitive', 1),
          instanceStart: this.reserveRange('instance', instanceCount),
          instanceCount,
          transformStart: this.reserveRange('transform', 1),
          instanceTransformStart:
            instances === undefined ? 0 : this.reserveRange('transform', instanceCount),
        }),
      );
      yield;
    }
  }

  /** Numeric tables only; the private descriptor root and native consumers remain required. */
  *encode(
    task: GpuSceneCapacityPreparation,
    current: () => boolean,
    stamp: () => number,
  ): Generator<void> {
    const transform = new Uint8Array(TRANSFORM);
    const transformView = new DataView(transform.buffer);
    const instance = new Uint8Array(INSTANCE);
    const instanceView = new DataView(instance.buffer);
    const primitive = new Uint8Array(GPU_SCENE_LAYOUTS.primitive.stride);
    const primitiveView = new DataView(primitive.buffer);
    for (const material of this.materials.values()) {
      if (!current()) throw new Error('Source material encoding is not current');
      if (material.payload !== undefined) {
        const data = material.payload.bytes;
        for (let offset = 0; offset < data.byteLength; offset += 64 * 1024) {
          task
            .writeRows(
              'material',
              material.payload.start * MATERIAL_SCENE_ADDRESS_UNIT_BYTES + offset,
              data.subarray(offset, offset + 64 * 1024),
            )
            .unwrap();
          yield;
          if (!current()) throw new Error('Source material encoding is not current');
        }
      }
    }
    for (const row of this.rows) {
      if (!current()) throw new Error('Source numeric encoding is not current');
      encodeResetSceneTransform(
        transformView,
        0,
        row.transformStart,
        row.snapshot.transform.world,
        0,
        stamp(),
      );
      task.writeRows('transform', row.transformStart * TRANSFORM, transform).unwrap();
      encodeScenePrimitive(
        primitiveView,
        row.source,
        row.snapshot,
        { ...row, sharedGeometry: true },
        0,
      );
      task.writeRows('primitive', row.recordIndex * primitive.byteLength, primitive).unwrap();
      yield;
      for (let ordinal = 0; ordinal < row.instanceCount; ordinal++) {
        if (!current()) throw new Error('Source numeric encoding is not current');
        const local = row.snapshot.instances?.transforms;
        const transformIndex =
          row.snapshot.instances === undefined ? 0 : row.instanceTransformStart + ordinal;
        encodeSceneInstance(instanceView, 0, row.recordIndex, transformIndex, 0, 1);
        task.writeRows('instance', (row.instanceStart + ordinal) * INSTANCE, instance).unwrap();
        if (transformIndex !== 0) {
          const hasLocal = local !== undefined && local.length >= (ordinal + 1) * 16;
          encodeResetSceneTransform(
            transformView,
            0,
            transformIndex,
            hasLocal ? local : IDENTITY,
            hasLocal ? ordinal * 16 : 0,
            stamp(),
          );
          task.writeRows('transform', transformIndex * TRANSFORM, transform).unwrap();
        }
        yield;
      }
    }
  }

  /** One exact address claim per grant, after native writes have been fenced by Source. */
  retireStep(): boolean {
    const material = this.materials.entries().next().value;
    if (material !== undefined) {
      material[1].release();
      this.descriptorBytes -= (material[1].privateDescriptor?.wordCount ?? 0) * 4;
      this.materials.delete(material[0]);
      return false;
    }
    const mesh = this.meshes.entries().next().value;
    if (mesh !== undefined) {
      mesh[1].release();
      this.descriptorBytes -= (mesh[1].privateDescriptor?.wordCount ?? 0) * 4;
      this.meshes.delete(mesh[0]);
      return false;
    }
    const range = this.held.at(-1);
    if (range !== undefined) {
      range.release();
      this.held.pop();
      return false;
    }
    this.rows.length = 0;
    this.snapshots.length = 0;
    this.geometries.length = 0;
    this.bindings.length = 0;
    this.sources = [];
    return true;
  }
}
