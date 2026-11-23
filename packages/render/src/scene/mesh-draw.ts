import { meshGeometryDraws } from '../gpu-driven/mesh-batches';
import type { RenderableSnapshot } from '../render-system-extract';
import { offsetWaterMeshAdmissionDraw } from '../water/mesh-source-admission';
import { CapturedSceneTransform } from './captured-transform';
import type { MeshFrame, MeshGeometry } from './mesh-frame';
import { createMeshMaterialReader, meshMaterialGeometry } from './mesh-materials';
import type { RenderSceneSlot } from './render-scene-types';
import type { RowContent } from './row-contents';

/**
 * The effective draw materials only, without a draw snapshot. Pose-only
 * replacements reuse the per-Mesh override binding, so temporal and GPU Scene
 * readers avoid rebuilding the complete draw row for every moved instance.
 */
export function meshDrawMaterials(
  source: Pick<
    RenderableSnapshot,
    | 'terrain'
    | 'materialOverrides'
    | 'assetHandle'
    | 'material'
    | 'materials'
    | 'materialBindingSources'
    | 'skinBinding'
    | 'spriteInstances'
  >,
  meshes: MeshFrame,
): Pick<RenderableSnapshot, 'material' | 'materials'> {
  if (source.terrain !== undefined || source.materialOverrides === undefined) return source;
  const mesh = meshes.get(source.assetHandle);
  return mesh === undefined
    ? source
    : createMeshMaterialReader(mesh)(source, meshMaterialGeometry(source));
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
  ordinary: ReturnType<ReturnType<typeof createMeshMaterialReader>>,
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

/** The retained row owner shares geometry and material projection across equal row contents.
 * A pose edit publishes a new matrix and entity address without rebuilding mesh sections.
 * Each live content holds at most its last binding, independent of the number of poses or views. */
export class SceneMeshDrawShapes {
  readonly #shapes = new WeakMap<
    RowContent,
    {
      readonly mesh: MeshGeometry;
      readonly read: ReturnType<typeof createMeshMaterialReader>;
      readonly materials: RenderableSnapshot['materials'];
      readonly shape: RowContent;
    }
  >();

  resolve(content: RowContent, meshes: MeshFrame): RowContent {
    if (content.terrain !== undefined || content.materialOverrides === undefined) return content;
    const mesh = meshes.get(content.assetHandle);
    if (mesh === undefined) {
      this.#shapes.delete(content);
      return content;
    }
    let entry = this.#shapes.get(content);
    const read = entry?.mesh === mesh ? entry.read : createMeshMaterialReader(mesh);
    const ordinary = read(content, meshMaterialGeometry(content));
    if (entry?.mesh !== mesh || entry.materials !== ordinary.materials) {
      const materials = meshDrawMaterialsWithWaterSource(content, ordinary);
      const shape = projectMeshFields(content, mesh, materials, ordinary.materials);
      entry = { mesh, read, materials: ordinary.materials, shape };
      this.#shapes.set(content, entry);
    }
    return entry.shape;
  }
}

/** A captured lane owns an immutable pose and shared authored fields. Public
 * enumeration includes snapshot; native draw and bounds readers consume their own fields. */
export class SceneDrawSlot implements RenderSceneSlot {
  declare readonly snapshot: RenderableSnapshot;
  static readonly #snapshotProperty = {
    configurable: true,
    enumerable: true,
    get(this: SceneDrawSlot) {
      return this.authoredSnapshot();
    },
  };
  readonly #content: RowContent;
  readonly #pose: Float32Array;
  readonly #offset: number;
  #transform: RenderableSnapshot['transform'] | undefined;
  readonly #shapes: SceneMeshDrawShapes;
  static #nextUploadVersion = 0;
  #uploadVersion: number | undefined;
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
    this.#content = content;
    this.#pose = poses;
    this.#offset = offset;
    this.#shapes = shapes;
    Object.defineProperty(this, 'snapshot', SceneDrawSlot.#snapshotProperty);
  }

  get content(): RowContent {
    return this.#content;
  }

  /** The column and its offset remain valid for the full lifetime of this issued row. */
  get poseColumn(): Float32Array {
    return this.#pose;
  }

  get poseOffset(): number {
    return this.#offset;
  }

  get transform(): RenderableSnapshot['transform'] {
    this.#transform ??= new CapturedSceneTransform(this.#pose, this.#offset);
    return this.#transform;
  }

  /** Authored and ordinary Mesh projections share this row's physical pose, temporal and
   * surface bytes. View overlays and externally supplied sources carry independent facts. */
  meshUploadVersion(source: RenderableSnapshot): number | undefined {
    if (!this.ownsSnapshot(source)) return undefined;
    // Opaque external identities are positive. Each issued native version is unique
    // across scene owners, including replacements that reuse the same physical address.
    if (
      this.#uploadVersion === undefined &&
      SceneDrawSlot.#nextUploadVersion > Number.MIN_SAFE_INTEGER
    )
      this.#uploadVersion = --SceneDrawSlot.#nextUploadVersion;
    return this.#uploadVersion;
  }

  ownsSnapshot(source: RenderableSnapshot): boolean {
    return source === this.#authored || source === this.#draw;
  }

  authoredSnapshot(): RenderableSnapshot {
    this.#authored ??= {
      ...this.#content,
      entityKey: this.entityKey,
      transform: this.transform,
    };
    return this.#authored;
  }

  draw(meshes: MeshFrame): RenderableSnapshot {
    const shape = this.#shapes.resolve(this.#content, meshes);
    if (shape === this.#content) {
      this.#draw = this.#drawShape = undefined;
      return this.authoredSnapshot();
    }
    if (shape !== this.#drawShape || this.#draw === undefined) {
      this.#draw = { ...shape, entityKey: this.entityKey, transform: this.transform };
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
  const ordinary = createMeshMaterialReader(mesh)(source, meshMaterialGeometry(source));
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
