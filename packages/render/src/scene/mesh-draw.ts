import { meshGeometryDraws } from '../gpu-driven/mesh-batches';
import { getOpaqueResourceIdentity } from '../opaque-resource-identity';
import type { RenderableSnapshot } from '../render-system-extract';
import { offsetWaterMeshAdmissionDraw } from '../water/mesh-source-admission';
import { CapturedSceneTransform, ScenePose, type ScenePoseStorage } from './captured-transform';
import type { MeshFrame, MeshGeometry } from './mesh-frame';
import {
  BoundMeshMaterials,
  type EffectiveMeshMaterials,
  effectiveMeshMaterials,
  meshMaterialGeometry,
} from './mesh-materials';
import type { RenderSceneSlot } from './render-scene-types';
import type { RowContent } from './row-contents';

/**
 * The effective draw materials only, without a draw snapshot. Pose-only
 * replacements reuse the per-Mesh override binding, so temporal and GPU Scene
 * readers avoid rebuilding the complete draw row for every moved instance.
 */
export function slotDrawMaterials(
  slot: RenderSceneSlot,
  meshes: MeshFrame,
): Pick<RenderableSnapshot, 'material' | 'materials'> {
  if (slot instanceof SceneDrawSlot) return slot.drawMaterials(meshes);
  const source = slot.snapshot;
  if (source.terrain !== undefined || source.materialOverrides === undefined) return source;
  const mesh = meshes.get(source.assetHandle);
  return mesh === undefined
    ? source
    : effectiveMeshMaterials(source, mesh, meshMaterialGeometry(source));
}

function offsetWaterMeshSource(
  source: NonNullable<RenderableSnapshot['waterMeshSource']>,
  offset: number,
): NonNullable<RenderableSnapshot['waterMeshSource']> {
  if (offset === 0) return source;
  return Object.freeze({
    ...source,
    materialStartIndex: source.materialStartIndex + offset,
    views: Object.freeze(
      source.views.map((view) =>
        Object.freeze({
          ...view,
          draws: Object.freeze(
            view.draws.map((draw) => offsetWaterMeshAdmissionDraw(draw, offset)),
          ),
        }),
      ),
    ),
  });
}

function meshDrawMaterialsWithWaterSource(
  source: RowContent,
  ordinary: EffectiveMeshMaterials,
): Pick<
  RenderableSnapshot,
  'material' | 'materials' | 'materialBindingSources' | 'waterMeshSource'
> {
  const waterMeshSource = source.waterMeshSource;
  if (waterMeshSource === undefined) return ordinary;
  const materialOffset = ordinary.materials.length - waterMeshSource.materialStartIndex;
  return {
    material: ordinary.material,
    materials: [
      ...ordinary.materials,
      ...source.materials.slice(waterMeshSource.materialStartIndex),
    ],
    materialBindingSources: [
      ...ordinary.materialBindingSources,
      ...source.materialBindingSources.slice(waterMeshSource.materialStartIndex),
    ],
    waterMeshSource: offsetWaterMeshSource(waterMeshSource, materialOffset),
  };
}

/** One live mesh/material address per admitted row content, shared by all its poses. */
class MeshDrawShape extends BoundMeshMaterials {
  private binding?: EffectiveMeshMaterials;
  private shape?: RowContent;

  constructor(
    mesh: MeshGeometry,
    content: RowContent,
    overrides: NonNullable<RowContent['materialOverrides']>,
    public frame: symbol,
  ) {
    super(mesh, overrides, meshMaterialGeometry(content));
  }

  project(content: RowContent): RowContent {
    const ordinary = this.read();
    if (ordinary !== this.binding || this.shape === undefined) {
      const materials = meshDrawMaterialsWithWaterSource(content, ordinary);
      this.shape = projectMeshFields(content, this.mesh, materials, ordinary.materials);
      this.binding = ordinary;
    }
    return this.shape;
  }
}

export class SceneMeshDrawShapes {
  readonly uploadOwner = -getOpaqueResourceIdentity(this);
  readonly #shapes = new WeakMap<RowContent, MeshDrawShape>();

  resolve(content: RowContent, meshes: MeshFrame): RowContent {
    return this.binding(content, meshes)?.project(content) ?? content;
  }

  materials(content: RowContent, meshes: MeshFrame): EffectiveMeshMaterials {
    return this.binding(content, meshes)?.read() ?? content;
  }

  private binding(content: RowContent, meshes: MeshFrame): MeshDrawShape | undefined {
    const overrides = content.materialOverrides;
    if (content.terrain !== undefined || overrides === undefined) return undefined;
    let entry = this.#shapes.get(content);
    if (entry === undefined || entry.frame !== meshes.identity) {
      const mesh = meshes.get(content.assetHandle);
      if (mesh === undefined) {
        this.#shapes.delete(content);
        return undefined;
      }
      if (entry?.mesh === mesh) entry.frame = meshes.identity;
      else {
        entry = new MeshDrawShape(mesh, content, overrides, meshes.identity);
        this.#shapes.set(content, entry);
      }
    }
    return entry;
  }
}

/** A draw which keeps the exact published pose address. The public transform
 * property is enumerable so copying or serializing the observation still works. */
class SceneDrawSnapshot {
  readonly #slot: SceneDrawSlot;
  readonly entityKey: number;
  declare readonly transform: RenderableSnapshot['transform'];

  static readonly #transformProperty = {
    configurable: true,
    enumerable: true,
    get(this: SceneDrawSnapshot) {
      return this.#slot.transform;
    },
  };

  constructor(slot: SceneDrawSlot) {
    this.#slot = slot;
    this.entityKey = slot.entityKey;
    Object.defineProperty(this, 'transform', SceneDrawSnapshot.#transformProperty);
  }

  static pose(source: Pick<RenderableSnapshot, 'transform'>): SceneDrawSlot | undefined {
    return source instanceof SceneDrawSnapshot ? source.#slot : undefined;
  }
}

/** Numeric recording and sorting can use the existing address without opening a matrix view. */
export function drawPoseStorage(source: Pick<RenderableSnapshot, 'transform'>): ScenePoseStorage {
  return SceneDrawSnapshot.pose(source) ?? CapturedSceneTransform.storage(source.transform);
}

export function nativeDrawSlot(source: RenderableSnapshot): SceneDrawSlot | undefined {
  return SceneDrawSnapshot.pose(source);
}

export function drawPoseReflected(source: Pick<RenderableSnapshot, 'transform'>): boolean {
  return CapturedSceneTransform.reflectedStorage(drawPoseStorage(source));
}

/** A captured lane owns an immutable pose and shared authored fields. Public
 * enumeration includes snapshot; native draw and bounds readers consume their own fields. */
export class SceneDrawSlot extends ScenePose implements RenderSceneSlot {
  declare readonly snapshot: RenderableSnapshot;
  static readonly #snapshotProperty = {
    configurable: true,
    enumerable: true,
    get(this: SceneDrawSlot) {
      return this.authoredSnapshot();
    },
  };
  readonly #content: RowContent;
  #transform: RenderableSnapshot['transform'] | undefined;
  readonly #shapes: SceneMeshDrawShapes;
  #authored: RenderableSnapshot | undefined;
  #drawShape: RowContent | undefined;
  #draw: RenderableSnapshot | undefined;

  constructor(
    readonly slot: number,
    readonly generation: number,
    readonly version: number,
    readonly entityKey: number,
    content: RowContent,
    poses: Float32Array,
    offset: number,
    shapes: SceneMeshDrawShapes,
  ) {
    super(poses, offset);
    this.#content = content;
    this.#shapes = shapes;
    Object.defineProperty(this, 'snapshot', SceneDrawSlot.#snapshotProperty);
  }

  get content(): RowContent {
    return this.#content;
  }

  /** A pose publication keeps the owning Scene, row lifetime and authored geometry facts. */
  retainsContentOf(previous: RenderSceneSlot | undefined): boolean {
    return (
      previous instanceof SceneDrawSlot &&
      this !== previous &&
      this.#shapes === previous.#shapes &&
      this.slot === previous.slot &&
      this.generation === previous.generation &&
      this.entityKey === previous.entityKey &&
      this.#content === previous.#content
    );
  }

  get transform(): RenderableSnapshot['transform'] {
    // Dense writes share internal pages. Explicit matrix reads detach only their own
    // sixteen floats, so a retained matrix cannot pin that wider backing.
    this.#transform ??= new CapturedSceneTransform(this.poseColumn, this.poseOffset);
    return this.#transform;
  }

  /** Native pose versions are scoped to this Scene owner. */
  get uploadOwner(): number {
    return this.#shapes.uploadOwner;
  }

  ownsSnapshot(source: RenderableSnapshot): boolean {
    return source === this.#authored || source === this.#draw;
  }

  ownsAuthoredSnapshot(source: RenderableSnapshot): boolean {
    return source === this.#authored;
  }

  authoredSnapshot(): RenderableSnapshot {
    this.#authored ??= Object.assign(new SceneDrawSnapshot(this), this.#content);
    return this.#authored;
  }

  drawMaterials(meshes: MeshFrame): EffectiveMeshMaterials {
    return this.#shapes.materials(this.#content, meshes);
  }

  drawContent(meshes: MeshFrame): RowContent {
    return this.#shapes.resolve(this.#content, meshes);
  }

  draw(meshes: MeshFrame): RenderableSnapshot {
    const shape = this.drawContent(meshes);
    if (shape === this.#content) {
      this.#draw = this.#drawShape = undefined;
      return this.authoredSnapshot();
    }
    if (shape !== this.#drawShape || this.#draw === undefined) {
      this.#draw = Object.assign(new SceneDrawSnapshot(this), shape);
      this.#drawShape = shape;
    }
    return this.#draw;
  }
}

export function slotContent(slot: RenderSceneSlot): RowContent {
  return slot instanceof SceneDrawSlot ? slot.content : slot.snapshot;
}

export function slotTransform(slot: RenderSceneSlot): RenderableSnapshot['transform'] {
  return slot instanceof SceneDrawSlot ? slot.transform : slot.snapshot.transform;
}

export function slotPoseColumn(slot: RenderSceneSlot): Float32Array {
  return slot instanceof SceneDrawSlot ? slot.poseColumn : slot.snapshot.transform.world;
}

export function slotPoseOffset(slot: RenderSceneSlot): number {
  return slot instanceof SceneDrawSlot ? slot.poseOffset : 0;
}

export function slotDrawSnapshot(slot: RenderSceneSlot, meshes: MeshFrame): RenderableSnapshot {
  return slot instanceof SceneDrawSlot
    ? slot.draw(meshes)
    : meshDrawSnapshot(slot.snapshot, meshes);
}

/** A borrowed source can be reused for a different draw. Project its current fields once.
 * Published scene slots own their stable draw observations through SceneDrawSlot.draw. */
export function meshDrawSnapshot(
  source: RenderableSnapshot,
  meshes: MeshFrame,
  issued?: RenderSceneSlot,
): RenderableSnapshot {
  if (issued instanceof SceneDrawSlot && issued.ownsSnapshot(source)) return issued.draw(meshes);
  if (source.terrain !== undefined || source.materialOverrides === undefined) return source;
  const mesh = meshes.get(source.assetHandle);
  if (mesh === undefined) return source;
  const ordinary = effectiveMeshMaterials(source, mesh, meshMaterialGeometry(source));
  return projectMeshDrawSnapshot(
    source,
    mesh,
    meshDrawMaterialsWithWaterSource(source, ordinary),
    ordinary.materials,
  );
}

/** Fixed shared geometry/material projection used by Source and ordinary rows. */
export function projectMeshDrawSnapshot(
  source: RenderableSnapshot,
  mesh: MeshGeometry,
  materials: Pick<RenderableSnapshot, 'material' | 'materials'>,
  geometryMaterials = materials.materials,
): RenderableSnapshot {
  return projectMeshFields(source, mesh, materials, geometryMaterials);
}

function projectMeshFields<T extends RowContent>(
  source: T,
  mesh: MeshGeometry,
  materials: Pick<RenderableSnapshot, 'material' | 'materials'>,
  geometryMaterials: RenderableSnapshot['materials'],
): T {
  const authored: RowContent = source;
  const { lods: _lods, lodHysteresis: _hysteresis, localAabb: _bounds, ...current } = authored;
  // The rest object is fresh and unescaped; publish it after projecting shared geometry.
  // Borrowed getter inputs can select the source itself, preserving their second spread/read.
  const result: { -readonly [Key in keyof RowContent]: RowContent[Key] } =
    materials === source ? { ...current, ...materials } : Object.assign(current, materials);
  if (source.gpuDrivenDraws !== undefined) {
    result.gpuDrivenDraws = meshGeometryDraws(
      mesh,
      geometryMaterials,
      source.skinBinding === undefined ? 'rigid' : 'skin',
    );
  }
  // Morphed rows keep their weight-expanded producer bounds.
  if (source.morph !== undefined) {
    if (source.localAabb !== undefined) result.localAabb = source.localAabb;
  } else if (mesh.bounds !== undefined) result.localAabb = mesh.bounds;
  if (mesh.lods !== undefined) result.lods = mesh.lods;
  if (mesh.lodHysteresis !== undefined) result.lodHysteresis = mesh.lodHysteresis;

  return result as T;
}
