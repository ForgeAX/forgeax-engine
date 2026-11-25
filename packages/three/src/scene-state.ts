import type { MeshRange } from '@forgeax/engine-assets-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import type { AssetHandle, ClippingOptions } from '@forgeax/engine-types';
import type { RenderItem } from 'three/src/renderers/common/Renderer.js';
import type {
  BufferGeometry,
  Camera,
  Frustum,
  Material,
  Matrix4,
  Object3D,
  Sprite,
  Texture,
} from 'three/src/Three.Core.js';
import type { SourceClipping } from './clipping';
import type { ExternalTextureDemand } from './external-textures';
import type {
  MaterialObservation,
  MaterialPublication,
  MaterialUse,
  MeshGeometryAsset,
  MeshGeometryPlan,
  MeshMaterialResidency,
  MeshPlan,
  OrdinaryMeshLayout,
  Renderable,
  TextureBindings,
  TextureBuckets,
  TexturePlan,
} from './scene-mesh-planning';
import type { MutableWalkMembers, WalkSlot } from './scene-walk';
import type { ShadowMapSettings } from './shadow';
import type { projectJoints } from './skinning';
import type { SceneChanges } from './source-changes';

export const EMPTY_SOURCE_TRANSFORM: readonly number[] = Object.freeze([]);

export interface PoseRecord {
  readonly entity: EntityHandle;
  transform: readonly number[] | Float64Array;
  parent?: EntityHandle | undefined;
  localVersion?: number | undefined;
  skinWorldRevision?: number | undefined;
}

export interface NodeRecord extends PoseRecord, Partial<Record<WalkSlot, number>> {
  readonly object: Object3D;
  groupOrder?: number;
  renderReady?: true;
  /** View-dependent and axis-converted draws keep a separate authored hierarchy pose. */
  sourcePose?: PoseRecord | undefined;
  instances?: readonly unknown[];
  nativeInstanceCount?: number;
  meshGeometry?: MeshGeometryPlan | undefined;
  /** Last native binding owned by the standalone projection. Borrowed Worlds
   * compare their live components so native edits cannot hide a source change. */
  binding?:
    | {
        mesh: AssetHandle<'mesh'>;
        materials: readonly AssetHandle<'material'>[];
        renderLayers: number;
        frustumCulled: boolean;
        layer: number;
      }
    | undefined;
  ordinaryMesh?: OrdinaryMeshLayout | undefined;
  meshMaterials?: MeshMaterialResidency | undefined;
  meshCachePins?: (() => void)[] | undefined;
  disposeSource?: () => void;
  joints?: EntityHandle[] | undefined;
  skinSourceJoints?: readonly EntityHandle[] | undefined;
  skinAffinePoint?: boolean;
  skinBinding?: AssetHandle<'skeleton'> | undefined;
  jointVersion?: number | undefined;
  jointPoses?: ReturnType<typeof projectJoints> | undefined;
}

export interface SceneBuffers {
  externalDemand?: ExternalTextureDemand | undefined;
  pixelRatio?: number;
  /** Keep leases observed by preceding offscreen passes in this composition. */
  deferResourceSweep?: boolean;
  depth: boolean;
  stencil: boolean;
  sortObjects: boolean;
  nativeTransparentOrder?: boolean;
  transparentSort?: ((a: RenderItem, b: RenderItem) => number) | null;
  opaqueOrder?: boolean;
  opaqueSort?: ((a: RenderItem, b: RenderItem) => number) | null;
  opaque: boolean;
  transparent: boolean;
  updateMatrices: boolean;
  ecsPoses?: boolean;
  shadowMap?: ShadowMapSettings;
}

export interface TransformPatch {
  pos: Float32Array;
  quat?: Float32Array;
  scale?: Float32Array;
}
export type SourceTransform =
  | {
      readonly values: number[];
      readonly data: TransformPatch;
      readonly skinWorldRevision?: number | undefined;
    }
  | { readonly pose: number[]; readonly localVersion?: number | undefined };

export interface FrameMeshPlans {
  readonly size: number;
  get(object: Renderable): MeshPlan | undefined;
  has(object: Renderable): boolean;
  set(object: Renderable, plan: MeshPlan): void;
  forEach(visit: (plan: MeshPlan, object: Renderable) => void): void;
}

/** Working collections for one source projection. Their entries expire before sync returns. */
export class ScenePreparationLists {
  readonly trackingSettings: unknown[] = [];
  readonly transformParents = new Map<Object3D, Object3D | null>();
  readonly transformAnchors = new Map<Object3D, boolean>();
  readonly pendingCasters: Renderable[] = [];
  readonly clipping = new Map<Object3D, SourceClipping | undefined>();
  readonly groupOrders = new Map<Object3D, number>();
  readonly transforms = new Map<Object3D, SourceTransform>();
  readonly transparentObjects: Renderable[] = [];
  readonly ordinaryGeometryReads = new Map<BufferGeometry, boolean>();
  readonly sharedMeshPlans = new Map<BufferGeometry, Map<Material, MeshPlan>>();
  readonly texturePlans: TextureBuckets<TexturePlan> = [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  readonly textureBindings: TextureBindings = [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  readonly materialObservations = new Map<Material, MaterialObservation>();
  readonly overrideObservations = new Map<Material, MaterialObservation>();
  readonly usedMaterials = [new Set<MaterialUse>(), new Set<MaterialUse>()] as const;
  readonly materialPublications = new Map<MaterialUse, MaterialPublication>();
  readonly meshAssets = new Map<BufferGeometry, Map<string, MeshGeometryAsset>>();
  readonly geometryInputs = [
    new Map<BufferGeometry, readonly unknown[]>(),
    new Map<BufferGeometry, readonly unknown[]>(),
  ] as const;
  readonly opaqueRanks = new Map<Object3D, number>();
  readonly transparentRanks = new Map<Object3D, number>();
  readonly uploadedTextures = new Set<Texture>();
  private readonly collections = [
    this.transformParents,
    this.transformAnchors,
    this.clipping,
    this.groupOrders,
    this.transforms,
    this.ordinaryGeometryReads,
    this.sharedMeshPlans,
    this.materialObservations,
    this.overrideObservations,
    ...this.usedMaterials,
    this.materialPublications,
    this.meshAssets,
    ...this.geometryInputs,
    this.opaqueRanks,
    this.transparentRanks,
    this.uploadedTextures,
  ];

  release(): void {
    this.trackingSettings.fill(undefined);
    this.pendingCasters.length = 0;
    this.transparentObjects.length = 0;
    for (const collection of this.collections) if (collection.size) collection.clear();
    // Buckets are created on first use. Drop their mappings with their sources;
    // the five-slot tables stay with this projection through its next invocation.
    this.texturePlans.fill(undefined);
    this.textureBindings.fill(undefined);
  }
}

/** One sync's source walk, pose edits and draw plans. */
export interface ScenePreparation {
  repairRanks?: Map<Renderable, number>;
  borrowedInstanceWindows?: (() => void)[];
  residualChildren?: ReadonlyMap<Object3D, Object3D[]>;
  retainedRankUpdates: number;
  planCalls: number;
  viewPoseChecks: number;
  changes?: SceneChanges | undefined;
  ecsPoses?: true;
  sourcePoseWrites: number;
  sourceWorldChanged?: boolean;
  visitedMounted: number;
  readonly lists: ScenePreparationLists;
  readonly scene: Object3D;
  readonly camera: Camera;
  readonly buffers: SceneBuffers;
  /** Reached source objects plus the scene and camera; removed nodes retire with poses. */
  readonly nodes: MutableWalkMembers;
  shadowMask: number;
  /** Camera-layer matches plus admitted shadow casters. */
  readonly visible: MutableWalkMembers;
  readonly meshes: FrameMeshPlans;
  pointRevisions?: (Pick<MeshPlan, 'geometry' | 'asset'> & { record: NodeRecord })[];
  meshRanges?: { readonly handle: AssetHandle<'mesh'>; readonly input: readonly MeshRange[] }[];
  spriteFilters?: Map<NodeRecord, AssetHandle<'mesh'>>;
  spriteAdmissions?: Map<Sprite, boolean>;
  readonly reusedDraws: Pick<Set<Renderable>, 'has'> & { add(object: Renderable): unknown };
  cameraClipping: ClippingOptions | undefined;
  orderedOpaque?: boolean;
  frustum?: Frustum | undefined;
  readWorld?: (object: Object3D) => Matrix4 | undefined;
}

export function createScenePreparation(
  scene: Object3D,
  camera: Camera,
  buffers: SceneBuffers,
  nodes: MutableWalkMembers,
  visible: MutableWalkMembers,
  meshes: FrameMeshPlans,
  reusedDraws: ScenePreparation['reusedDraws'],
  lists: ScenePreparationLists,
): ScenePreparation {
  return {
    planCalls: 0,
    retainedRankUpdates: 0,
    sourcePoseWrites: 0,
    viewPoseChecks: 0,
    visitedMounted: 0,
    lists,
    scene,
    camera,
    buffers,
    nodes,
    shadowMask: 0,
    visible,
    meshes,
    reusedDraws,
    cameraClipping: undefined,
  };
}
