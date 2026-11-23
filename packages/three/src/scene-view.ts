import { ClippingGroup } from 'three/src/objects/ClippingGroup.js';
import type { RenderItem } from 'three/src/renderers/common/Renderer.js';
import {
  BatchedMesh,
  type Camera,
  Frustum,
  InstancedMesh,
  LOD,
  Matrix4,
  Mesh,
  type Object3D,
  SkinnedMesh,
  Sphere,
  Sprite,
  type Vector3,
  Vector4,
} from 'three/src/Three.Core.js';
import { unsupported } from './errors';
import { isBlended, isRenderable, type MeshPlan, type Renderable } from './scene-mesh-planning';
import type { ScenePreparation } from './scene-state';

// A visible draw outside every clipping group precludes a shared camera plane.
export function unclippedWitness(node: Object3D, root: Object3D, camera: Camera): boolean {
  if (
    !isRenderable(node) ||
    Array.isArray(node.material) ||
    !node.material.visible ||
    !node.layers.test(camera.layers)
  )
    return false;
  for (let parent: Object3D | null = node; parent; parent = parent.parent) {
    if (!parent.visible || parent instanceof ClippingGroup || parent instanceof LOD) return false;
    if (parent === root) return true;
  }
  return false;
}

export function clippingCandidates(visible: Iterable<Object3D>): Renderable[] {
  return [...visible]
    .filter(isRenderable)
    .filter((object) =>
      (Array.isArray(object.material) ? object.material : [object.material]).some(
        (material) => material?.visible,
      ),
    );
}

const viewBounds = new Sphere();

export function outsideThreeFrustum(frame: ScenePreparation, object: Renderable): boolean {
  if (!object.frustumCulled || (frame.buffers.shadowMap?.enabled && object.castShadow))
    return false;
  const camera = frame.camera;
  if (frame.frustum === undefined) {
    const cameraWorld = frame.readWorld?.(camera);
    frame.frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        cameraWorld?.invert() ?? camera.matrixWorldInverse,
      ),
      camera.coordinateSystem,
      camera.reversedDepth,
    );
  }
  const frustum = frame.frustum;
  if (object instanceof Sprite) return !frustum.intersectsSprite(object);
  if (frame.readWorld === undefined || 'boundingSphere' in object)
    return !frustum.intersectsObject(object);
  const bounds = object.geometry;
  if (bounds.boundingSphere === null) bounds.computeBoundingSphere();
  const world = frame.readWorld(object) ?? object.matrixWorld;
  return !frustum.intersectsSphere(
    viewBounds.copy(bounds.boundingSphere as Sphere).applyMatrix4(world),
  );
}

/** Preserve native batching until the caller explicitly requests opaque ordering. */
export function rankOpaqueMeshes(frame: ScenePreparation): void {
  if (!frame.buffers.opaqueOrder) return;
  if (!frame.orderedOpaque && frame.buffers.sortObjects && frame.buffers.opaqueSort == null) return;
  const projection = new Matrix4().multiplyMatrices(
    frame.camera.projectionMatrix,
    frame.camera.matrixWorldInverse,
  );
  const items: { object: Renderable; item: RenderItem }[] = [];
  frame.meshes.forEach((plan, object) => {
    if (
      !object.layers.test(frame.camera.layers) ||
      !plan.materials.some((use) => !isBlended(use.effective)) ||
      (frame.buffers.opaqueSort != null && outsideThreeFrustum(frame, object))
    )
      return;
    if (
      !(object instanceof Mesh) ||
      object instanceof InstancedMesh ||
      object instanceof BatchedMesh ||
      Array.isArray(object.material) ||
      plan.materials.length !== 1 ||
      frame.lists.clipping.get(object) !== undefined
    )
      unsupported(
        'Opaque ordering requires single-material, unclipped ordinary meshes',
        object.uuid,
      ).unwrap();
    items.push({ object, item: sourceRenderItem(frame, object, plan, projection) });
  });
  if (frame.buffers.sortObjects) {
    const compare = frame.buffers.opaqueSort ?? painterSort;
    items.sort((a, b) => compare(a.item, b.item));
  }
  for (const [rank, { object }] of items.entries()) {
    // Keep explicit opaque ranks before transparent ranks in combined direct passes.
    frame.lists.opaqueRanks.set(object, rank - items.length);
  }
}

function painterSort(a: RenderItem, b: RenderItem): number {
  return (
    (a.groupOrder ?? 0) - (b.groupOrder ?? 0) ||
    (a.renderOrder ?? 0) - (b.renderOrder ?? 0) ||
    (a.z ?? 0) - (b.z ?? 0) ||
    (a.id ?? 0) - (b.id ?? 0)
  );
}

/** r187 StandardDrawingPipeline uses clip-space Z without division by W. */
function sourceRenderItem(
  frame: ScenePreparation,
  object: Renderable,
  plan: MeshPlan,
  projection: Matrix4,
): RenderItem {
  const geometry = object.geometry;
  const bounds = object instanceof SkinnedMesh ? object : geometry;
  if (bounds.boundingSphere === null) bounds.computeBoundingSphere();
  const localCenter = bounds.boundingSphere?.center;
  const center =
    object instanceof Sprite
      ? new Vector4().setFromMatrixPosition(object.matrixWorld)
      : new Vector4()
          .set(localCenter?.x ?? 0, localCenter?.y ?? 0, localCenter?.z ?? 0, 1)
          .applyMatrix4(object.matrixWorld);
  center.applyMatrix4(projection);
  return {
    id: object.id,
    object,
    geometry,
    material: plan.materials[0]?.source ?? null,
    groupOrder: frame.lists.groupOrders.get(object) ?? 0,
    renderOrder: object.renderOrder,
    z: center.z,
    group: null,
    clippingContext: null,
  };
}

interface TransparentEntry {
  object: Renderable;
  depth: number;
  group: number;
  order: number;
  rank: number;
  /** Number of retained draws preceding this dynamic draw. */
  gap: number;
}

type TransparentKey = Pick<TransparentEntry, 'object' | 'group' | 'order' | 'depth'>;
function compareTransparent(a: TransparentKey, b: TransparentKey): number {
  return a.group - b.group || a.order - b.order || a.depth - b.depth || a.object.id - b.object.id;
}

/** Keep sorted retained keys. A moving draw shifts only the native ranks it crosses. */
export class MixedTransparentOrder {
  private readonly fixed: TransparentEntry[] = [];
  private dynamic = new Map<Renderable, TransparentEntry>();

  rank(frame: ScenePreparation, center: Vector3): void {
    const changes = frame.changes;
    if (!changes) throw new Error('Missing tracked transparent view');
    const sparse = frame.residualChildren !== undefined;
    const current: TransparentEntry[] = [];
    let changed = !sparse || frame.lists.transparentObjects.length !== this.dynamic.size;
    for (const object of frame.lists.transparentObjects) {
      const depth = sourceDepth(object, frame.camera, center);
      const group = frame.lists.groupOrders.get(object) ?? 0,
        order = object.renderOrder;
      const draw = changes.viewDraws.get(object);
      if (draw) draw.depth = depth;
      const old = this.dynamic.get(object);
      if (sparse && old && old.group === group && old.order === order && old.depth === depth)
        current.push(old);
      else {
        changed = true;
        current.push({ object, group, order, depth, rank: 0, gap: 0 });
      }
    }
    if (!sparse) {
      this.fixed.length = 0;
      this.dynamic.clear();
      const paths = changes.residualChildren();
      for (const [rank, entry] of current.sort(compareTransparent).entries()) {
        entry.rank = rank;
        entry.gap = this.fixed.length;
        if (changes.viewDraws.has(entry.object) && !paths.has(entry.object)) this.fixed.push(entry);
        else this.dynamic.set(entry.object, entry);
        frame.lists.transparentRanks.set(entry.object, rank);
      }
      return;
    }
    if (changed) {
      const delta = new Map<number, number>();
      const adjust = (gap: number, amount: number) =>
        delta.set(gap, (delta.get(gap) ?? 0) + amount);
      const next = new Map<Renderable, TransparentEntry>();
      for (const [ordinal, entry] of current.sort(compareTransparent).entries()) {
        const old = this.dynamic.get(entry.object);
        if (old !== entry) {
          let low = 0,
            high = this.fixed.length;
          while (low < high) {
            const mid = (low + high) >>> 1;
            if (compareTransparent(this.fixed[mid] as TransparentEntry, entry) < 0) low = mid + 1;
            else high = mid;
          }
          entry.gap = low;
          if (old) adjust(old.gap, -1);
          adjust(low, 1);
        }
        entry.rank = ordinal + entry.gap;
        next.set(entry.object, entry);
      }
      for (const [object, old] of this.dynamic) if (!next.has(object)) adjust(old.gap, -1);
      let shift = 0,
        start = 0;
      const applyUntil = (end: number) => {
        if (shift)
          for (let i = start; i < end; i++) {
            const entry = this.fixed[i] as TransparentEntry;
            entry.rank += shift;
            frame.lists.transparentRanks.set(entry.object, entry.rank);
            frame.retainedRankUpdates++;
          }
        start = end;
      };
      for (const [gap, amount] of [...delta].sort(([a], [b]) => a - b)) {
        applyUntil(gap);
        shift += amount;
      }
      applyUntil(this.fixed.length);
      this.dynamic = next;
    }
    for (const entry of current) frame.lists.transparentRanks.set(entry.object, entry.rank);
  }
}

export function rankTransparentMeshes(frame: ScenePreparation, center: Vector3): void {
  const objects = frame.lists.transparentObjects;
  if (objects.length === 0) return;
  if (frame.buffers.sortObjects && frame.buffers.transparentSort != null) {
    rankCustomTransparent(frame, frame.buffers.transparentSort);
    return;
  }
  if (!frame.buffers.sortObjects || objects.length === 1) {
    for (const [rank, object] of objects.entries()) {
      frame.lists.transparentRanks.set(object, rank);
      const draw = frame.changes?.viewDraws.get(object);
      if (draw && frame.buffers.sortObjects) draw.depth = sourceDepth(object, frame.camera, center);
    }
    return;
  }
  const transparent = objects.map((object) => {
    const depth = sourceDepth(object, frame.camera, center);
    const draw = frame.changes?.viewDraws.get(object);
    if (draw) draw.depth = depth;
    return {
      object,
      depth,
      group: frame.lists.groupOrders.get(object) ?? 0,
      order: object.renderOrder,
    };
  });
  transparent.sort(compareTransparent);
  for (const [rank, { object }] of transparent.entries())
    frame.lists.transparentRanks.set(object, rank);
}

export function sourceDepth(object: Renderable, camera: Camera, center: Vector3): number {
  if (object instanceof Sprite) center.setFromMatrixPosition(object.matrixWorld);
  else {
    const local = sourceSortCenter(object);
    if (local === undefined) center.set(0, 0, 0);
    else center.copy(local);
    center.applyMatrix4(object.matrixWorld);
  }
  return center.applyMatrix4(camera.matrixWorldInverse).z;
}

export function sourceSortCenter(object: Renderable): Vector3 | undefined {
  const geometry = object.geometry;
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  return geometry.boundingSphere?.center;
}

/** Caller render items are created only when an explicit comparator is installed. */
function rankCustomTransparent(
  frame: ScenePreparation,
  compare: (a: RenderItem, b: RenderItem) => number,
): void {
  const projection = new Matrix4().multiplyMatrices(
    frame.camera.projectionMatrix,
    frame.camera.matrixWorldInverse,
  );
  const items: RenderItem[] = [];
  for (const object of frame.lists.transparentObjects) {
    if (outsideThreeFrustum(frame, object)) continue;
    const plan = frame.meshes.get(object);
    if (plan === undefined) throw new Error('admitted transparent object has no mesh plan');
    if (plan.materials.length !== 1 || frame.lists.clipping.get(object) !== undefined)
      unsupported(
        'Custom transparent sorting requires single-material, unclipped objects',
        object.uuid,
      ).unwrap();
    items.push(sourceRenderItem(frame, object, plan, projection));
  }
  items.sort(compare);
  for (const [rank, item] of items.entries())
    if (item.object !== null) frame.lists.transparentRanks.set(item.object, rank);
}
