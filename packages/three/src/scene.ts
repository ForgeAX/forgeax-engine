import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { adoptWithMeshRanges, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import {
  type Component,
  type ComponentSchema,
  type EntityHandle,
  type InputShapeOf,
  World,
} from '@forgeax/engine-ecs';
import { observeStateChanges } from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import {
  BLOOM_ENABLED,
  type CameraData,
  ClippingPlanes,
  clippingPlanesData,
  Instances,
  Layer,
  MeshFilter,
  MeshRenderer,
  Camera as NativeCamera,
  DirectionalLight as NativeDirectionalLight,
  Fog as NativeFog,
  Lines as NativeLines,
  PointLight as NativePointLight,
  PointLightShadow as NativePointLightShadow,
  Points as NativePoints,
  RectAreaLight as NativeRectAreaLight,
  SpotLight as NativeSpotLight,
  RenderTargetEnvironment,
  ShadowParticipation,
  SkyboxBackground,
  Skylight,
} from '@forgeax/engine-render';
import { setViewDrawOrder, type ViewDrawOrderSource } from '@forgeax/engine-render/internal';
import {
  ChildOf,
  Children,
  copyPresentationWorldMatrix,
  GlobalTransform,
  MorphWeights,
  Name,
  propagateTransforms,
  Transform,
} from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import {
  type AssetHandle,
  type ClippingOptions,
  type EquirectAsset,
  type MaterialAsset,
  type MaterialTextureValue,
  type MaterialValue,
  type MeshAsset,
  ok,
  type ResolvedMaterialTextureCoordinates,
  type SamplerAsset,
  type SkeletonAsset,
  type TextureAsset,
  unpackSlot,
  withClipping,
} from '@forgeax/engine-types';
import { ClippingGroup } from 'three/src/objects/ClippingGroup.js';
import {
  AmbientLight,
  AttachedBindMode,
  BatchedMesh,
  Bone,
  type BufferGeometry,
  Camera,
  Color,
  DirectionalLight,
  Fog,
  FogExp2,
  Group,
  InstancedMesh,
  Line,
  LOD,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  Object3D,
  PointLight,
  Points,
  Quaternion,
  RectAreaLight,
  Scene,
  type Skeleton,
  SkinnedMesh,
  SpotLight,
  Sprite,
  SpriteMaterial,
  type Texture,
  Vector3,
} from 'three/src/Three.Core.js';
import { cameraData, SourceCameraRows, writeSceneClearColor } from './camera';
import { CanvasTextures } from './canvas-textures';
import { objectClipping, projectClipping, type SourceClipping } from './clipping';
import { projectEnvironment, scaleEnvironment } from './environment';
import { invalid, ThreeCompatibilityError, unsupported } from './errors';
import { type ExternalTextures, isExternalTexture } from './external-textures';
import {
  type GeometryMaterial,
  hasPlainPointGeometry,
  type PointContentChannels,
  pointContentEdit,
  projectGeometry,
  readPointContent,
  repackPointContent,
} from './geometry';
import { InstanceTints, instanceGeometryValues, tintInstanceGeometry } from './instance-geometry';
import {
  type materialTextures,
  materialValues,
  projectMaterial,
  readStockMaterialEdit,
  stockMaterialParameterPatch,
  validateMaterial,
} from './material';
import { isMatcapMaterial, isNormalMaterial, isSpriteMaterial } from './material-kinds';
import { surfaceInput } from './node-inputs';
import {
  hasSurfaceBinding,
  observeThreeSurfaceInputs,
  readThreeSurfaceInput,
  type SurfaceInputObservation,
  threeSurfaceUvSets,
  validateThreeSurfaceGeometry,
} from './node-surface';
import {
  cameraPoseChain,
  canPublishLocalPose,
  decomposeSourceMatrix,
  hasPositiveUniformSourceBasis,
  hasSourceShear,
  POSE_LANES,
  readLocalPose,
  SourcePosePage,
  stockCameraView,
  writePose,
} from './pose';
import type { RenderTargets } from './render-targets';
import { expandScalarTexture } from './scalar-texture';
import {
  NO_EQUIRECT,
  projectFog,
  type SceneLighting,
  sceneAmbientIrradiance,
  validateLight,
} from './scene-lighting';
import {
  type AssetTexturePlan,
  allowsSharedMeshPlan,
  appendBindingValues,
  type CanvasTexturePlan,
  canvasBindingSource,
  compactNativeInstances,
  effectiveMaterial,
  finishMeshGeometry,
  flatMatcapSlots,
  type GeometryShape,
  type GeometrySourceData,
  geometryCacheValues,
  geometryVariant,
  instanceSourceValues,
  isBlended,
  isRenderable,
  isWireframe,
  type MaterialDependencies,
  type MaterialUse,
  type MeshGeometryAsset,
  type MeshGeometryPlan,
  type MeshGeometryProjection,
  type MeshMaterialResidency,
  type MeshPlan,
  matchesGeometrySelection,
  matchesGeometryStructure,
  matchesMaterialRoster,
  materialParameterPatch,
  meshLineStyle,
  meshMaterialPublication,
  meshMorphWeights,
  type NativeInstanceChange,
  nativeSkinMaterial,
  observeGeometry,
  observeMaterial,
  ordinaryGeometryReads,
  ordinaryMeshMaterial,
  ordinaryMeshSurface,
  overrideMaterial,
  POINT_CONTENT,
  plainStockMaterial,
  pointStyle,
  projectLinePointMaterial,
  projectNativeInstanceTransforms,
  projectSourceMesh,
  projectsMorphColor,
  type Renderable,
  recordUpload,
  registerOrdinaryMeshPlan,
  rejectOrderedOpaque,
  resolveMaterialBindings,
  reuseOrdinaryMaterial,
  sameBindingValues,
  sameMaterialCoordinates,
  sameTextureSlots,
  selectMaterials,
  sharedMaterialReads,
  sourceTopology,
  sparseInstanceTransforms,
  surfaceParameterSlots,
  type TextureBindings,
  type TextureProjection,
  textureProjection,
  textureProjectionSlots,
  trackableViewDraw,
  useTextures,
  uvTextures,
} from './scene-mesh-planning';
import {
  createScenePreparation,
  type NodeRecord,
  type PoseRecord,
  type SceneBuffers,
  type ScenePreparation,
  ScenePreparationLists,
  type SourceTransform,
} from './scene-state';
import {
  clippingCandidates,
  MixedTransparentOrder,
  outsideThreeFrustum,
  rankOpaqueMeshes,
  rankTransparentMeshes,
  sourceDepth,
  sourceSortCenter,
  unclippedWitness,
} from './scene-view';
import {
  type MutableWalkMembers,
  SceneMeshPlans,
  SceneWalkRows,
  type WalkMembers,
} from './scene-walk';
import { type ShadowLight, ShadowUpdates, shadowCasterChannels } from './shadow';
import { SharedAssets, sameValues } from './shared-assets';
import type { SkinCursor } from './skeleton-changes';
import {
  canProjectAffinePoint,
  canProjectLitSkin,
  cpuSkinGeometry,
  cpuSkinValues,
  type JointSnapshots,
  projectCpuSkin,
  projectJoints,
  projectLitJoints,
  projectSkeleton,
  skinValues,
} from './skinning';
import {
  localTransparentOrder,
  NodeStateFields,
  SceneChanges,
  separateDrawPose,
  trackingSelected,
} from './source-changes';
import { matrixStorage, publishWorldMatrix } from './source-collections';
import { ownSourceValue } from './source-fields';
import {
  reflectSourceWorldPose,
  resolveSourceLocalPose,
  sourceWorldRevision,
} from './source-world-pose';
import { SpritePoseReader, spriteMatrix } from './sprite';
import {
  projectSampler,
  projectTextureUpload,
  samplerValues,
  textureUploadPending,
  textureValues,
  validateTexture,
} from './texture';
import { TextureStorage } from './texture-storage';
import { MeshUvs, type UvProjection } from './uv-projection';

export interface ThreeSourceIdentity {
  readonly uuid: string;
  readonly name: string;
  readonly type: string;
  readonly entityKey: number;
}

interface SceneProjectionOptions {
  readonly targets?: RenderTargets;
  readonly canvasTextures?: boolean;
  readonly world?: World;
  readonly validateComponents?: readonly Component[];
  readonly validateSource?: (object: Object3D, entity: EntityHandle | undefined) => void;
  /** A mixed host owns its existing Scene/Physics propagation schedule. */
  readonly propagate?: boolean;
}

/** Projects ordinary source hierarchy and local transforms into Scene-owned native propagation. */
export class SceneProjection {
  constructor(
    private readonly assets: AssetRegistry,
    private readonly external?: ExternalTextures,
    private readonly prepareMaterialPrograms?: (
      material: MaterialAsset,
      skinned?: boolean,
    ) => MaterialAsset,
    private readonly options: SceneProjectionOptions = {},
  ) {
    this.world = options.world ?? new World({ assets });
    this.nativeOwners = options.world ? new Map() : undefined;
    this.canvasTextures = options.canvasTextures ? new CanvasTextures() : undefined;
    this.geometry = new SharedAssets(assets);
    this.materials = [new SharedAssets(assets), new SharedAssets(assets)];
    this.textures = [
      new SharedAssets(assets, new TextureStorage(assets)),
      new SharedAssets(assets, new TextureStorage(assets)),
    ];
    this.samplers = new SharedAssets(assets);
    this.environments = new SharedAssets(assets);
    this.skeletons = new SharedAssets(assets);
    this.resourceStores = [
      this.geometry,
      ...this.materials,
      ...this.textures,
      this.samplers,
      this.environments,
      this.skeletons,
    ];
  }

  readonly world: World;
  private readonly resourceStores: readonly Pick<
    SharedAssets<BufferGeometry, MeshAsset>,
    'begin' | 'commit' | 'abort' | 'dispose'
  >[];
  private readonly canvasTextures: CanvasTextures | undefined;
  readonly shadowUpdates = new ShadowUpdates();
  private readonly textureUpdates = new Set<Texture>();

  submitted(): void {
    this.shadowUpdates.submitted();
    const updates = [...this.textureUpdates];
    this.textureUpdates.clear();
    for (const texture of updates) texture.onUpdate?.(texture);
  }

  private readonly nodes = new Map<Object3D, NodeRecord>();
  private readonly sourceWalk = new SceneWalkRows(this.nodes, 'sourceWalkSlot');
  private readonly visibleWalk = new SceneWalkRows(this.nodes, 'visibleWalkSlot');
  private readonly poseWalk = new SceneWalkRows(this.nodes, 'poseWalkSlot');
  private readonly meshPlans = new SceneMeshPlans(this.nodes);
  private readonly reusedDraws = new SceneWalkRows<Renderable>(this.nodes, 'reusedDrawSlot');
  private readonly preparationLists = new ScenePreparationLists();
  private walking = false;
  private viewOrderOwners: Map<number, Object3D> | undefined;
  private viewOrderCamera: Camera | undefined;
  private readonly viewOrderMatrix: number[] = [];
  private readonly stockDefinitions: {
    source: WeakRef<Material>;
    variant: string;
    shading: 0 | 1;
  }[] = [];
  private mixedOrder?: MixedTransparentOrder | undefined;
  private readonly sortCenter = new Vector3();
  private readonly poseScratch: number[] = [];
  private readonly poseMatrix = new Matrix4();
  private readonly poseExpectedWorld = new Matrix4();
  private readonly poseFields = { pos: vec3.create(), quat: quat.create(), scale: vec3.create() };
  private readonly spritePose = new SpritePoseReader();
  private readonly presentationLanes = new Float32Array(16);
  private readonly presentationMatrix = new Matrix4();
  private readonly poseOwners = new Map<number, Object3D>();
  private readonly sourcePoses = new SourcePosePage();
  private readonly localMatrixPosition = new Vector3();
  private readonly localMatrixRotation = new Quaternion();
  private readonly localMatrixScale = new Vector3();
  private ecsPoseChanges?: ReturnType<typeof observeStateChanges> | undefined;
  private readonly readWorld = (object: Object3D): Matrix4 | undefined => {
    const record = this.nodes.get(object);
    const entity = record?.sourcePose?.entity ?? record?.entity;
    if (
      entity !== undefined &&
      copyPresentationWorldMatrix(this.world, entity, this.presentationLanes)
    )
      return this.presentationMatrix.fromArray(this.presentationLanes);
    return undefined;
  };

  private readonly lightDirection = new Vector3();
  private readonly lightOrigin = new Vector3();
  private readonly meshUvs = new WeakMap<Renderable, MeshUvs>();
  private readonly instanceTints = new InstanceTints();
  private readonly cameraRows = new SourceCameraRows();
  private projectingCamera = false;

  syncCamera(
    scene: Object3D,
    camera: Camera,
    input: {
      readonly toneMapping: number;
      readonly exposure: number;
      readonly clearColor: Color;
      readonly clearAlpha: number;
      readonly antialias?: number;
      readonly bloom?: import('./post-processing').ThreePostProcessing['bloom'];
    },
    buffers: SceneBuffers,
  ): EntityHandle {
    const nested = this.projectingCamera;
    this.projectingCamera = true;
    try {
      const data = cameraData(
        camera,
        input.toneMapping,
        input.exposure,
        nested ? new SourceCameraRows() : this.cameraRows,
      );
      const fields = NativeCamera.fields;
      data.bloom = input.bloom === undefined ? (fields.bloom.default as number) : BLOOM_ENABLED;
      data.bloomIntensity = input.bloom?.intensity ?? (fields.bloomIntensity.default as number);
      data.bloomRadius = input.bloom?.radius ?? (fields.bloomRadius.default as number);
      data.bloomThreshold = input.bloom?.threshold ?? (fields.bloomThreshold.default as number);
      data.antialias = input.antialias ?? (fields.antialias.default as number);
      writeSceneClearColor(data.clearColor, scene, input.clearColor, input.clearAlpha);
      return this.sync(scene, camera, data, buffers);
    } finally {
      this.projectingCamera = nested;
    }
  }
  private plainLighting: { signature: readonly unknown[]; data: SceneLighting } | undefined;
  private committedLighting: { data: SceneLighting; ambient: readonly number[] } | undefined;
  private readonly jointSnapshots: JointSnapshots = new WeakMap();
  private readonly batchRosters = new WeakMap<BatchedMesh, Uint32Array>();
  private readonly maximumJointIndices = new WeakMap<Uint16Array, number>();
  private readonly geometry: SharedAssets<BufferGeometry, MeshAsset, GeometrySourceData>;
  // Geometry can require flat shading while another mesh shares this source material.
  private readonly materials: readonly [
    SharedAssets<Material, MaterialAsset, MaterialDependencies>,
    SharedAssets<Material, MaterialAsset, MaterialDependencies>,
  ];
  // Native matcap coordinates already invert V. Keep its image projection separate
  // when the same Three texture is also used in an ordinary UV slot.
  private readonly textures: readonly [
    SharedAssets<Texture, TextureAsset>,
    SharedAssets<Texture, TextureAsset>,
  ];
  private readonly skeletons: SharedAssets<Skeleton, SkeletonAsset>;
  private readonly environments: SharedAssets<Texture, EquirectAsset>;
  private readonly samplers: SharedAssets<Texture, SamplerAsset>;

  private lastWork:
    | {
        mode: 'full' | 'tracked';
        poseAuthority: 'ecs' | 'three';
        sourceNodes: number;
        meshPlans: number;
        materialUses: number;
        poseChanges: number;
        residentNodes: number;
        viewBindings: number;
        viewPoseChecks: number;
        retainedRankUpdates: number;
        jointReads: number;
        foreignInputChecks: number;
        rosterEntries: number;
      }
    | undefined;

  sourceWork() {
    return this.lastWork && { ...this.lastWork };
  }

  private nodeRecord(object: Object3D): NodeRecord {
    const record = this.nodes.get(object);
    if (!record) throw new Error('Admitted Three object has no native entity');
    return record;
  }

  private changes: SceneChanges | undefined;
  private readonly nativeOwners: Map<number, Object3D> | undefined;
  private readonly nativeRepairs = new Set<Object3D>();
  private nativeChanges?: ReturnType<typeof observeStateChanges> | undefined;

  private reconcileNativeChanges(changes: SceneChanges): void {
    const cursor = this.nativeChanges;
    if (!cursor || cursor.isCurrent()) return;
    const batch = cursor.read();
    for (const index of batch.indices) {
      const object = this.nativeOwners?.get(index);
      if (!object) continue;
      const record = this.nodeRecord(object);
      this.assertRetirableNode(record);
      this.validateTransformParent(record);
      this.options.validateSource?.(object, record.entity);
      record.skinBinding = undefined;
      record.jointPoses = undefined;
      record.transform = [];
      record.localVersion = undefined;
      record.instances = [];
      if (object === changes.root) {
        this.committedLighting = undefined;
      }
      this.nativeRepairs.add(object);
    }
    batch.accept();
  }
  private previousCamera: Camera | undefined;

  updateMatrices(scene: Object3D, camera: Camera, reconciled = false): void {
    const changes = this.changes;
    if (
      changes?.root === scene &&
      !scene.parent &&
      scene.matrixAutoUpdate &&
      scene.matrixWorldAutoUpdate &&
      trackingSelected(scene) &&
      !changes.invalid
    ) {
      try {
        if (!reconciled) changes.reconcile();
        if (!changes.invalid) {
          changes.updateMatrices(camera);
          return;
        }
      } catch (error) {
        this.releaseTracking();
        throw error;
      }
    }
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
  }

  private releaseTracking(): void {
    if (this.changes) {
      this.changes.dispose();
      for (const record of this.nodes.values()) releaseMeshCache(record);
    }
    this.changes = undefined;
    this.mixedOrder = undefined;
    this.nativeChanges = undefined;
    this.nativeRepairs.clear();
    this.plainLighting = undefined;
    this.committedLighting = undefined;
  }

  sync(
    scene: Object3D,
    camera: Camera,
    cameraData: CameraData,
    buffers: SceneBuffers = {
      depth: true,
      stencil: false,
      sortObjects: true,
      opaque: true,
      transparent: true,
      updateMatrices: true,
    },
  ): EntityHandle {
    if (this.walking)
      return this.syncScene(
        scene,
        camera,
        cameraData,
        buffers,
        new Set(),
        new Set(),
        new Set(),
        new Map(),
        new Set(),
        new SourcePosePage(),
        new ScenePreparationLists(),
      );
    this.walking = true;
    try {
      return this.syncScene(
        scene,
        camera,
        cameraData,
        buffers,
        this.sourceWalk,
        this.visibleWalk,
        this.poseWalk,
        this.meshPlans,
        this.reusedDraws,
        this.sourcePoses,
        this.preparationLists,
      );
    } finally {
      this.preparationLists.release();
      this.walking = false;
      this.sourceWalk.release();
      this.visibleWalk.release();
      this.poseWalk.release();
      this.meshPlans.release();
      this.reusedDraws.release();
      this.nodeName.value = '';
      this.sourcePoses.release(this.nodes.size);
    }
  }

  private syncScene(
    scene: Object3D,
    camera: Camera,
    cameraData: CameraData,
    buffers: SceneBuffers,
    nodes: MutableWalkMembers,
    visible: MutableWalkMembers,
    poses: MutableWalkMembers,
    meshes: ScenePreparation['meshes'],
    reusedDraws: ScenePreparation['reusedDraws'],
    sourcePoses: SourcePosePage,
    lists: ScenePreparationLists,
  ): EntityHandle {
    const tracked = trackingSelected(scene);
    if (tracked && this.changes?.root === scene) {
      try {
        this.changes.reconcile();
      } catch (error) {
        this.releaseTracking();
        throw error;
      }
    }
    const settings = tracked
      ? [
          buffers.depth,
          buffers.stencil,
          buffers.opaque,
          buffers.transparent,
          buffers.sortObjects,
          buffers.nativeTransparentOrder,
          buffers.opaqueSort,
          buffers.transparentSort,
          buffers.opaqueOrder,
          buffers.shadowMap?.enabled,
          buffers.shadowMap?.type,
          overrideMaterial(scene),
          scene.parent,
          scene.matrixAutoUpdate,
          scene.matrixWorldAutoUpdate,
          buffers.ecsPoses,
        ]
      : [];
    if (
      this.changes &&
      (!tracked ||
        this.changes.invalid ||
        (this.changes.unclipped !== undefined &&
          !unclippedWitness(this.changes.unclipped, scene, camera)) ||
        this.changes.root !== scene ||
        !sameValues(this.changes.settings, settings))
    )
      this.releaseTracking();
    const ecsPoseNodes = buffers.ecsPoses
      ? this.ecsPoseNodes(scene, camera, poses, sourcePoses)
      : undefined;
    const ecsPoses = ecsPoseNodes !== undefined;
    if (ecsPoses !== (this.ecsPoseChanges !== undefined)) this.switchPoseOwner(ecsPoses);
    if (!ecsPoses && buffers.updateMatrices) this.updateMatrices(scene, camera, true);
    let opened = 0;
    try {
      for (const store of this.resourceStores) {
        store.begin();
        opened++;
      }
      this.canvasTextures?.begin();
    } catch (error) {
      // An outer source callback can already own a later store. Close only
      // the stores opened here and keep earlier offscreen usage intact.
      while (opened > 0) this.resourceStores[--opened]?.abort(true);
      throw error;
    }
    try {
      if (this.changes) this.reconcileNativeChanges(this.changes);
      const frame = createScenePreparation(
        scene,
        camera,
        buffers,
        nodes,
        visible,
        meshes,
        reusedDraws,
        lists,
      );
      frame.changes = this.changes;
      if (ecsPoseNodes !== undefined) {
        frame.ecsPoses = true;
        this.publishEcsPoses(frame, ecsPoseNodes, sourcePoses);
        frame.readWorld = this.readWorld;
      }
      const geometryContentEdits = this.prepareTransforms(frame);
      if (ecsPoses) this.publishDrawPoses(frame);
      else this.publishTransforms(frame);
      this.previousCamera = camera;
      if (!ecsPoses && this.options.propagate !== false) {
        frame.readWorld = this.readWorld;
        frame.frustum = undefined;
      }
      const commitScene = adoptWithMeshRanges(
        this.assets,
        () => ok(this.prepareDraws(frame, cameraData, geometryContentEdits)),
        () => frame.meshRanges,
      ).unwrap();
      for (const store of this.resourceStores) store.commit(!buffers.deferResourceSweep);
      commitScene();
      this.publishViewDrawOrder(frame);
      if (
        tracked &&
        !this.changes &&
        !scene.parent &&
        scene.matrixAutoUpdate &&
        scene.matrixWorldAutoUpdate &&
        buffers.opaque &&
        buffers.sortObjects &&
        !buffers.opaqueSort &&
        !frame.orderedOpaque &&
        !overrideMaterial(scene)
      )
        this.trackFrame(frame, settings);
      else if (frame.changes) {
        const changes = frame.changes;
        changes.promote((node) => this.trackNode(frame, changes, node));
      }
      if (this.nativeOwners && this.changes) {
        this.nativeChanges ??= observeStateChanges(
          this.world,
          [
            Transform,
            Name,
            ChildOf,
            Children,
            MeshFilter,
            MeshRenderer,
            Layer,
            ShadowParticipation,
            NativeCamera,
            NativeLines,
            NativePoints,
            Instances,
            MorphWeights,
            Skin,
            NativeDirectionalLight,
            NativePointLight,
            NativePointLightShadow,
            NativeSpotLight,
            NativeRectAreaLight,
            ClippingPlanes,
            NativeFog,
            RenderTargetEnvironment,
            Skylight,
            SkyboxBackground,
            ...(this.options.validateComponents ?? []),
          ],
          this.nativeOwners,
        );
        this.nativeChanges.resetBaseline();
      }
      this.lastWork = {
        mode: frame.changes ? 'tracked' : 'full',
        poseAuthority: ecsPoses ? 'ecs' : 'three',
        sourceNodes:
          frame.nodes.size -
          Number(frame.nodes.has(scene)) -
          Number(camera !== scene && frame.nodes.has(camera)),
        meshPlans: frame.planCalls,
        viewPoseChecks: frame.viewPoseChecks,
        retainedRankUpdates: frame.retainedRankUpdates,
        jointReads: frame.changes?.jointReads ?? 0,
        materialUses: frame.lists.usedMaterials[0].size + frame.lists.usedMaterials[1].size,
        poseChanges: frame.sourcePoseWrites + frame.lists.transforms.size,
        residentNodes: this.changes?.residents.size ?? 0,
        viewBindings: this.changes?.viewDraws.size ?? 0,
        foreignInputChecks: frame.changes?.checkedInputs ?? 0,
        rosterEntries: frame.changes?.rosterEntries ?? 0,
      };
      if (frame.changes) {
        frame.changes.jointReads = 0;
        frame.changes.checkedInputs = 0;
        frame.changes.rosterEntries = 0;
      }
      this.canvasTextures?.commit(!buffers.deferResourceSweep);
      return this.nodeRecord(camera).entity;
    } catch (error) {
      this.releaseTracking();
      this.canvasTextures?.abort();
      for (const store of this.resourceStores)
        store.abort(error !== undefined && error === buffers.externalDemand);
      throw error;
    }
  }

  /** Only the authored TRS lane is eligible for the shared Scene hierarchy. */
  private ecsPoseNodes(
    scene: Object3D,
    camera: Camera,
    walk: MutableWalkMembers,
    page: SourcePosePage,
  ): WalkMembers | undefined {
    if (this.options.propagate === false || scene.parent !== null) return;
    const changes = this.ecsPoseChanges === undefined ? undefined : this.changes;
    const nodes = changes === undefined ? walk : page.takeEdits(changes);
    if (changes === undefined) scene.traverse((node) => nodes.add(node));
    else for (const node of changes.unobservedNativePoses) nodes.add(node);
    const members = changes?.members ?? nodes;
    if (camera.parent !== null && !members.has(camera)) return;
    nodes.add(camera);
    const manualCameraChain = cameraPoseChain(camera);
    if (manualCameraChain === null) return;
    let values = page.reserve(nodes.size);
    let offset = 0;
    for (const node of nodes) {
      if (!canPublishLocalPose(node)) return;
      const parent = node.parent;
      if (parent && !members.has(parent)) return;
      if (offset + POSE_LANES > values.length)
        values = page.reserve(Math.max(nodes.size, offset / POSE_LANES + 1), true);
      if (!this.readEcsLocalPose(node, values, offset, manualCameraChain?.has(node))) return;
      offset += POSE_LANES;
    }
    page.used = offset;
    return nodes;
  }

  private readonly localPosition = vec3.create();
  private readonly localRotation = quat.create();
  private readonly localScale = vec3.create();
  private readonly localShear = vec3.create();

  private readEcsLocalPose(
    object: Object3D,
    pose: Float64Array,
    offset: number,
    rigid?: boolean,
  ): boolean {
    if (object.matrixAutoUpdate) return readLocalPose(object, pose, true, offset);
    const p = this.localPosition,
      q = this.localRotation,
      s = this.localScale;
    if (!mat4.decomposeAffine(p, q, s, this.localShear, object.matrix.elements)) return false;
    // A source-owned manual matrix must retain shear in Three's world cache.
    if (hasSourceShear(this.localShear)) return false;
    if (rigid && (s[0] !== 1 || s[1] !== 1 || s[2] !== 1)) return false;
    return writePose(
      pose,
      p[0] as number,
      p[1] as number,
      p[2] as number,
      q[0] as number,
      q[1] as number,
      q[2] as number,
      q[3] as number,
      s[0] as number,
      s[1] as number,
      s[2] as number,
      false,
      offset,
    );
  }

  private switchPoseOwner(ecsPoses: boolean): void {
    this.releaseTracking();
    for (const record of this.nodes.values()) {
      this.detachTransformParent(record.sourcePose ?? record);
      record.transform = [];
      record.localVersion = undefined;
    }
    this.poseOwners.clear();
    for (const [object, record] of this.nodes) {
      if (record.sourcePose !== undefined) {
        this.world.despawn(record.sourcePose.entity).unwrap();
        record.sourcePose = undefined;
      }
      if (ecsPoses && !separateDrawPose(object))
        this.poseOwners.set(unpackSlot(record.entity), object);
    }
    this.ecsPoseChanges = ecsPoses
      ? observeStateChanges(this.world, [GlobalTransform], this.poseOwners)
      : undefined;
  }

  private publishEcsPoses(frame: ScenePreparation, nodes: WalkMembers, page: SourcePosePage): void {
    const { changes, camera } = frame;
    const topology = page.capturedTopology;
    if (topology && camera.parent === null) {
      const record = this.nodes.get(camera);
      if (!record || record.parent !== undefined) topology.add(camera);
    }
    this.commitSourceTopology(frame.scene, topology ?? nodes, page);
    this.commitSourcePoses(frame, nodes, page);
    this.retireEcsSources(changes, camera, nodes);
    propagateTransforms(this.world).unwrap();
    frame.sourceWorldChanged = this.reflectWorldPoses(frame, nodes);
    this.reflectCameraView(camera);
    for (const node of changes?.stockSkins ?? nodes)
      if (node instanceof SkinnedMesh)
        node.bindMatrixInverse
          .copy(node.bindMode === AttachedBindMode ? node.matrixWorld : node.bindMatrix)
          .invert();
    changes?.reconcileBindings();
  }

  private commitSourceTopology(scene: Object3D, nodes: WalkMembers, page: SourcePosePage): void {
    for (const object of nodes) {
      const record = this.nodes.get(object) ?? this.spawnNode(object);
      if (record.sourcePose === undefined && separateDrawPose(object)) {
        record.sourcePose = {
          entity: this.world.spawn({ component: Transform, data: {} }).unwrap(),
          transform: [],
        };
        this.poseOwners.set(unpackSlot(record.sourcePose.entity), object);
      }
      const pose = record.sourcePose ?? record;
      const parent = object === scene ? null : object.parent;
      if (parent === null) {
        this.detachTransformParent(pose);
        continue;
      }
      // Tracked edges can arrive child-first. A missing parent gets its normal spawn
      // position during this walk, before any replacement relationship is installed.
      const parentRecord = this.nodes.get(parent);
      if (
        pose.parent !== undefined &&
        pose.parent === (parentRecord?.sourcePose ?? parentRecord)?.entity
      )
        continue;
      this.detachTransformParent(pose);
      page.pendingParents[page.parentCount++] = object;
    }
    // All obsolete edges are detached. A valid reversal can now attach either end first.
    for (let i = 0; i < page.parentCount; i++) {
      const object = page.pendingParents[i] as Object3D;
      const parent = object.parent;
      if (parent === null) continue;
      const pose = this.sourcePose(object);
      if (pose.parent !== undefined) continue;
      const parentEntity = this.sourcePose(parent).entity;
      this.world
        .addComponent(pose.entity, { component: ChildOf, data: { parent: parentEntity } })
        .unwrap();
      pose.parent = parentEntity;
    }
  }

  private commitSourcePoses(
    frame: ScenePreparation,
    nodes: WalkMembers,
    page: SourcePosePage,
  ): void {
    const values = page.values;
    let offset = 0;
    for (const object of nodes) {
      if (offset >= page.used) throw new Error('Source pose did not pass validation');
      const record = this.sourcePose(object);
      const previous = record.transform;
      let changed = previous.length !== POSE_LANES;
      for (let i = 0; !changed && i < POSE_LANES; i++)
        changed = !Object.is(previous[i], values[offset + i]);
      if (changed) {
        this.writeLocalTransform(record, values, offset);
        previous.length = POSE_LANES;
        for (let i = 0; i < POSE_LANES; i++) previous[i] = values[offset + i] as number;
        record.localVersion = undefined;
        frame.sourcePoseWrites++;
      }
      if (
        object.matrixAutoUpdate &&
        (changed || !frame.changes || frame.changes.matrixRepairs.has(object))
      )
        this.writeSourceLocalMatrix(object, values, offset);
      offset += POSE_LANES;
    }
  }

  private retireEcsSources(
    changes: SceneChanges | undefined,
    camera: Camera,
    nodes: WalkMembers,
  ): void {
    if (changes) {
      for (const object of changes.retired)
        if (!changes.members.has(object) && object !== camera) this.retireSource(object);
      const previous = this.previousCamera;
      if (previous && previous !== camera && !changes.members.has(previous))
        this.retireSource(previous);
    } else if (this.nodes.size !== nodes.size) {
      // Every distinct current source now has a record. Only surplus records can retire.
      for (const object of this.nodes.keys()) if (!nodes.has(object)) this.retireSource(object);
    }
  }

  private sourcePose(object: Object3D): PoseRecord {
    const record = this.nodeRecord(object);
    return record.sourcePose ?? record;
  }

  private retireSource(object: Object3D): void {
    const record = this.nodes.get(object);
    if (record === undefined) return;
    this.detachTransformParent(record.sourcePose ?? record);
    this.releaseNode(record);
    this.nodes.delete(object);
    if (isRenderable(object)) this.meshUvs.delete(object);
  }

  private writeSourceLocalMatrix(object: Object3D, source: Float64Array, offset: number): void {
    if (resolveSourceLocalPose(object)) return;
    const target = matrixStorage(object.matrix.elements);
    const elements = this.poseMatrix.compose(
      this.localMatrixPosition.fromArray(source, offset),
      this.localMatrixRotation.fromArray(source, offset + 3),
      this.localMatrixScale.fromArray(source, offset + 7),
    ).elements;
    for (let i = 0; i < 16; i++) target[i] = elements[i] as number;
  }

  private reflectWorldPoses(frame: ScenePreparation, nodes: WalkMembers): boolean {
    const { camera, changes } = frame;
    const cursor = this.ecsPoseChanges;
    if (cursor === undefined) return false;
    if (changes === undefined) {
      for (const object of nodes) this.reflectWorldPose(object, camera);
      cursor.resetBaseline();
      return true;
    }
    // Stock automatic updates overwrite external edits to the cached matrices.
    // A cache-only edit still needs repair if Scene's derived pose was unchanged.
    const edits = changes.matrixRepairs;
    let changed = edits.size !== 0;
    for (const object of edits) this.reflectWorldPose(object, camera);
    if (!cursor.isCurrent()) {
      const batch = cursor.read();
      for (const slot of batch.indices) {
        const object = this.poseOwners.get(slot);
        if (object === undefined || edits.has(object)) continue;
        this.reflectWorldPose(object, camera);
        changed = true;
      }
      batch.accept();
    }
    if (edits.size) edits.clear();
    return changed;
  }

  private reflectWorldPose(object: Object3D, camera: Camera): void {
    const record = this.nodes.get(object);
    if (record === undefined) return;
    const elements = object.matrixWorld.elements;
    const target = matrixStorage(elements);
    if (target.length < 16) target.length = 16;
    if (
      !copyPresentationWorldMatrix(this.world, record.sourcePose?.entity ?? record.entity, target)
    )
      return;
    object.matrixWorldNeedsUpdate = false;
    if (object !== camera && object instanceof Camera) this.reflectCameraView(object);
    reflectSourceWorldPose(object);
    publishWorldMatrix(elements);
  }

  private reflectCameraView(camera: Camera): void {
    stockCameraView(camera, camera.matrixWorldInverse);
  }

  private publishDrawPoses(frame: ScenePreparation): void {
    if (frame.lists.transforms.size === 0) return;
    for (const [object, transform] of frame.lists.transforms)
      this.commitTransform(this.nodeRecord(object), transform);
    // Draw poses are flat output entities independent of the source tree.
    propagateTransforms(this.world).unwrap();
  }

  private prepareTransforms(
    frame: ScenePreparation,
  ): ReadonlyMap<BufferGeometry, PointContentChannels> | undefined {
    const { camera, changes } = frame;
    let geometryContentEdits: ReadonlyMap<BufferGeometry, PointContentChannels> | undefined;
    this.walkScene(frame);
    this.spritePose.begin();
    if (changes) {
      for (const object of this.nativeRepairs) {
        if (frame.nodes.has(object)) continue;
        const draw = isRenderable(object) ? changes.viewDraws.get(object) : undefined;
        if (draw && isRenderable(object)) {
          frame.nodes.add(object);
          if (draw.live) frame.visible.add(object);
          if (draw.blended && draw.live) {
            frame.repairRanks ??= new Map();
            frame.repairRanks.set(object, draw.rank);
          }
        } else if (changes.residents.has(object)) {
          frame.nodes.add(object);
          if (object.visible && (isRenderable(object) || object.layers.test(camera.layers)))
            frame.visible.add(object);
        }
      }
      const geometries = changes.changedGeometry;
      if (geometries.size) {
        geometryContentEdits = geometries;
        changes.changedGeometry = new Map();
      }
      for (const geometry of geometries.keys()) {
        for (const mesh of changes.geometry.get(geometry) ?? []) {
          frame.nodes.add(mesh);
          frame.visible.add(mesh);
        }
      }
      const poses = changes.projectedPose;
      changes.consumeLights(
        camera.layers.mask,
        frame.buffers.shadowMap?.cameraLayers ?? 1,
        this.shadowUpdates.pendingLights,
        poses,
        (light) => {
          frame.nodes.add(light);
          if (light.layers.test(camera.layers)) {
            this.validateObject(light);
            frame.visible.add(light);
          }
        },
      );
      const spriteDemand = frame.buffers.nativeTransparentOrder && this.options.world === undefined;
      if (spriteDemand) this.updateTrackedSprites(frame, changes, poses);
      for (const sprite of changes.spritePoses)
        if (!spriteDemand || changes.viewDraws.get(sprite)?.live) poses.add(sprite);
      changes.spritePoses.clear();
      if (poses.size) changes.projectedPose = new Set();
      for (const object of poses) {
        if (
          object.visible &&
          !frame.nodes.has(object) &&
          (changes.residents.has(object) ||
            (isRenderable(object) && changes.viewDraws.has(object))) &&
          (!frame.ecsPoses || separateDrawPose(object))
        )
          this.projectTransform(frame, object);
      }
    }
    this.shadowUpdates.begin();
    this.projectTransforms(frame);
    return geometryContentEdits;
  }

  private updateTrackedSprites(
    frame: ScenePreparation,
    changes: SceneChanges,
    poses: Set<Object3D>,
  ): void {
    if (changes.spriteViewChanged) {
      const movedInPerspective = changes.cameraMoved && 'isPerspectiveCamera' in frame.camera;
      for (const sprite of changes.retainedSprites) {
        if (
          this.updateSpriteBinding(frame, changes, sprite, poses) &&
          (changes.cameraBasisMoved || (movedInPerspective && !sprite.material.sizeAttenuation))
        )
          poses.add(sprite);
      }
    } else {
      for (const sprite of changes.spriteVisibility)
        this.updateSpriteBinding(frame, changes, sprite, poses);
      for (const object of poses)
        if (
          object instanceof Sprite &&
          changes.retainedSprites.has(object) &&
          !changes.spriteVisibility.has(object)
        )
          this.updateSpriteBinding(frame, changes, object, poses);
    }
    changes.spriteVisibility.clear();
  }

  /** Keep source material and geometry bound across view-demand changes. */
  private updateSpriteBinding(
    frame: ScenePreparation,
    changes: SceneChanges,
    sprite: Sprite,
    poses: Set<Object3D>,
  ): boolean {
    const draw = changes.viewDraws.get(sprite);
    const live =
      sprite.visible &&
      sprite.layers.test(frame.camera.layers) &&
      !outsideThreeFrustum(frame, sprite);
    if (!live) poses.delete(sprite);
    if (!draw) {
      if (live) {
        changes.retainedSprites.delete(sprite);
        changes.promoteBinding(sprite);
        frame.nodes.add(sprite);
        frame.visible.add(sprite);
        frame.spriteAdmissions ??= new Map();
        frame.spriteAdmissions.set(sprite, true);
      } else frame.visible.delete(sprite);
      return false;
    }
    if (live === draw.live) return live;
    const record = this.nodeRecord(sprite);
    const geometry = record.meshGeometry;
    if (geometry === undefined) throw new Error('Tracked Sprite lost its geometry binding');
    const handle = live
      ? this.geometry.previous(geometry.source, geometry.variant)?.handle
      : (0 as AssetHandle<'mesh'>);
    if (handle === undefined) {
      // A disposed source is admitted again using its current layout.
      frame.nodes.add(sprite);
      frame.visible.add(sprite);
      this.nativeRepairs.add(sprite);
      return true;
    }
    draw.live = live;
    frame.spriteFilters ??= new Map();
    frame.spriteFilters.set(record, handle);
    if (live) {
      poses.add(sprite);
      changes.materials.add(sprite.material);
    }
    return live;
  }

  private prepareDraws(
    frame: ScenePreparation,
    cameraData: CameraData,
    geometryContentEdits: ReadonlyMap<BufferGeometry, PointContentChannels> | undefined,
  ): () => void {
    const { scene, camera, buffers, changes } = frame;
    const lighting = this.sceneLighting(scene, frame.lists.uploadedTextures, changes);
    if (changes) {
      const materials = changes.materials;
      if (materials.size) changes.materials = new Set();
      for (const source of materials) {
        for (const use of changes.uses.get(source)?.values() ?? []) {
          if (use.view && !use.direct) continue;
          let mesh = use.meshes.values().next().value;
          if (use.view && mesh && !changes.viewDraws.get(mesh)?.live) {
            // An inactive source has no draw binding. Publish shared material
            // edits through a consumer with an active binding.
            mesh = undefined;
            for (const candidate of use.meshes) {
              if (changes.viewDraws.get(candidate)?.live) {
                mesh = candidate;
                break;
              }
            }
          }
          if (!mesh) continue;
          const observation = observeMaterial(frame, source, source, false);
          if (!use.view && !observation)
            throw new Error('Tracked material lost its ordinary projection');
          const layout = this.nodes.get(mesh)?.ordinaryMesh;
          this.admitMaterialUse(frame, mesh, {
            source,
            effective:
              observation?.material ??
              validateMaterial(
                hasSurfaceBinding(source)
                  ? effectiveMaterial(source, source, frame.buffers)
                  : source,
              ).unwrap(),
            ...(observation ? { observation } : {}),
            shading: use.shading,
            variant: use.variant,
            coordinates: new Map(use.coordinates ?? layout?.uv.coordinates),
            skinProgram: use.skinProgram,
          });
        }
      }
    }
    const clipping =
      frame.lists.clipping.size === 0
        ? undefined
        : projectClipping(
            clippingCandidates(frame.visible),
            frame.lists.clipping,
            !changes?.unclipped,
          );
    frame.cameraClipping = clipping?.camera;
    for (const object of frame.nodes) {
      if (!isRenderable(object)) continue;
      if (
        buffers.nativeTransparentOrder &&
        this.options.world === undefined &&
        object instanceof Sprite &&
        changes?.viewDraws.has(object) &&
        !this.nativeRepairs.has(object)
      ) {
        frame.reusedDraws.add(object);
        continue;
      }
      if (frame.visible.has(object)) {
        const draw = changes?.viewDraws.get(object);
        const geometryEdit = geometryContentEdits?.get(object.geometry);
        if (
          draw?.live &&
          !this.nativeRepairs.has(object) &&
          (!(object instanceof Points) ||
            (draw.zoom === camera.projectionMatrix.elements[5] &&
              draw.perspective === camera.projectionMatrix.elements[11] &&
              draw.pixelRatio === (buffers.pixelRatio ?? 1))) &&
          (!draw.republishPointContent ||
            geometryEdit === undefined ||
            this.preparePointRevision(frame, object, geometryEdit))
        ) {
          frame.reusedDraws.add(object);
          if (!buffers.nativeTransparentOrder && draw.blended && object.layers.test(camera.layers))
            frame.lists.transparentObjects.push(object);
          continue;
        }
        this.planMesh(frame, object, clipping?.local.get(object));
      }
      if (!frame.meshes.has(object)) {
        const record = this.nodes.get(object);
        const mesh = record?.meshCachePins === undefined ? record?.meshGeometry : undefined;
        if (mesh !== undefined && object.geometry === mesh.source) {
          this.geometry.markUsed(mesh.source, mesh.variant);
          if (matchesMaterialRoster(frame.scene, object, record?.meshMaterials))
            this.useCachedMaterials(record.meshMaterials);
        }
      }
    }
    this.nativeRepairs.clear();
    if (buffers.externalDemand?.size) throw buffers.externalDemand;
    const ambientIrradiance = sceneAmbientIrradiance(
      scene,
      frame.visible,
      changes,
      camera.layers.mask,
    );
    // New resource leases stay provisional until all material preparation succeeds.
    rankOpaqueMeshes(frame);
    if (frame.lists.usedMaterials[0].size || frame.lists.usedMaterials[1].size)
      this.publishMaterials(frame, this.publishTextures(frame));
    if (changes?.materialEdits.size) this.publishMaterialEdits(changes);
    if (frame.meshes.size || frame.pointRevisions?.length) this.publishGeometry(frame);
    if (buffers.nativeTransparentOrder) {
      this.mixedOrder = undefined;
    } else if (changes?.hasResiduals && changes.viewDraws.size) {
      this.mixedOrder ??= new MixedTransparentOrder();
      this.mixedOrder.rank(frame, this.sortCenter);
    } else {
      this.mixedOrder = undefined;
      rankTransparentMeshes(frame, this.sortCenter);
    }
    if (frame.repairRanks && !buffers.nativeTransparentOrder)
      for (const [object, rank] of frame.repairRanks) {
        if (!frame.lists.transparentRanks.has(object))
          frame.lists.transparentRanks.set(object, rank);
      }
    for (const validate of frame.borrowedInstanceWindows ?? []) validate();
    return () => this.commitDraws(frame, lighting, ambientIrradiance, cameraData);
  }

  /** Keep the admitted source assets when this view cannot draw the attached mesh. */
  /** Publish the local view facts before Render admits and orders its visible draws. */
  private publishViewDrawOrder(frame: ScenePreparation): void {
    if (!frame.buffers.nativeTransparentOrder) {
      if (this.viewOrderCamera !== undefined) {
        setViewDrawOrder(this.world, undefined);
        this.viewOrderCamera = undefined;
      }
      return;
    }
    const camera = frame.camera;
    const view = matrixStorage(camera.matrixWorldInverse.elements);
    if (
      frame.changes &&
      camera === this.viewOrderCamera &&
      frame.meshes.size === 0 &&
      !frame.pointRevisions?.length &&
      frame.lists.transforms.size === 0 &&
      !frame.sourceWorldChanged &&
      sameValues(view, this.viewOrderMatrix)
    )
      return;
    this.viewOrderCamera = camera;
    for (let i = 0; i < view.length; i++) this.viewOrderMatrix[i] = view[i] as number;
    let owners = this.viewOrderOwners;
    if (owners === undefined) {
      owners = new Map();
      for (const [object, record] of this.nodes) owners.set(record.entity, object);
      this.viewOrderOwners = owners;
    }
    const nativePoses = frame.ecsPoses;
    setViewDrawOrder(this.world, {
      view: view.slice(),
      localFor: (entity): ViewDrawOrderSource | undefined => {
        const object = owners.get(entity);
        if (object === undefined || !isRenderable(object)) return undefined;
        const record = this.nodes.get(object);
        if (record?.orderedTransparency !== true) return undefined;
        const sprite = object instanceof Sprite;
        const center = sprite ? undefined : sourceSortCenter(object);
        return {
          group: record.groupOrder ?? 0,
          priority: object.renderOrder,
          center: center ? [center.x, center.y, center.z] : [0, 0, 0],
          tie: object.id,
          ...(!nativePoses || sprite
            ? { authoredWorld: matrixStorage(object.matrixWorld.elements) }
            : {}),
        };
      },
    });
  }

  private pinMeshCache(record: NodeRecord): void {
    const geometry = record.meshGeometry;
    if (geometry === undefined) return;
    const pin = this.geometry.pin(geometry.source, geometry.variant);
    if (pin === undefined) return;
    const pins = [pin];
    if (record.meshMaterials !== undefined) this.useCachedMaterials(record.meshMaterials, pins);
    releaseMeshCache(record);
    record.meshCachePins = pins;
  }

  /** Strict draws discover resource usage each frame; tracked bindings own the same dependencies. */
  private useCachedMaterials(materials: MeshMaterialResidency, pins?: (() => void)[]): void {
    const hold = (pin: (() => void) | undefined) => {
      if (pin !== undefined) pins?.push(pin);
    };
    for (const address of materials.addresses) {
      const cache = this.materials[address.shading];
      if (pins) hold(cache.pin(address.source, address.variant));
      const dependencies = pins
        ? cache.sourceData(address.source, address.variant)
        : cache.markUsed(address.source, address.variant);
      if (dependencies === undefined) continue;
      for (const { source, projection, canvas } of dependencies.textures) {
        if (canvas !== undefined) {
          hold(this.canvasTextures?.retain(canvas, pins !== undefined));
        }
        if (projection !== undefined) {
          const [orientation, variant] = textureProjectionSlots[projection];
          if (pins) hold(this.textures[orientation].pin(source, variant));
          else this.textures[orientation].markUsed(source, variant);
        }
        if (pins) hold(this.samplers.pin(source, ''));
        else this.samplers.markUsed(source);
      }
    }
  }

  /** Scene-owned image lighting and backdrop; validates the Scene-level Three features first. */
  private sceneLighting(
    scene: Object3D,
    uploads: Set<Texture>,
    changes: SceneChanges | undefined,
  ): SceneLighting {
    if (
      !changes ||
      !(scene instanceof Scene) ||
      scene.environment ||
      (scene.fog !== null && !(scene.fog instanceof Fog) && !(scene.fog instanceof FogExp2)) ||
      (scene.background !== null && !(scene.background instanceof Color))
    ) {
      this.plainLighting = undefined;
      return this.prepareSceneLighting(scene, uploads);
    }
    const fog = scene.fog;
    const sky = scene.environmentRotation,
      backdrop = scene.backgroundRotation;
    const signature = [
      scene,
      scene.environmentIntensity,
      sky.x,
      sky.y,
      sky.z,
      sky.order,
      backdrop.x,
      backdrop.y,
      backdrop.z,
      backdrop.order,
      fog,
      fog?.color.r,
      fog?.color.g,
      fog?.color.b,
      fog instanceof Fog ? fog.near : undefined,
      fog instanceof Fog ? fog.far : undefined,
      fog instanceof FogExp2 ? fog.density : undefined,
    ];
    if (this.plainLighting && sameValues(this.plainLighting.signature, signature))
      return this.plainLighting.data;
    const data = this.prepareSceneLighting(scene, uploads);
    this.plainLighting = { signature, data };
    return data;
  }

  private prepareSceneLighting(scene: Object3D, uploadedTextures: Set<Texture>): SceneLighting {
    if (!(scene instanceof Scene))
      return {
        lighting: NO_EQUIRECT,
        background: NO_EQUIRECT,
        lightingRotation: [0, 0, 0, 1],
        backgroundRotation: [0, 0, 0, 1],
      };
    const fog = projectFog(scene);
    if (
      scene.background !== null &&
      !(scene.background instanceof Color) &&
      scene.backgroundBlurriness !== 0
    )
      return unsupported(
        'Scene.backgroundBlurriness requires native sky roughness/LOD controls',
        scene.uuid,
      ).unwrap();
    const targetEnvironment = scene.environment?.isRenderTargetTexture
      ? (this.options.targets?.environment(scene.environment) ??
        unsupported(
          'GPU environment requires the renderer target owner',
          scene.environment.uuid,
        ).unwrap())
      : undefined;
    if (
      scene.background !== null &&
      !(scene.background instanceof Color) &&
      scene.background.isRenderTargetTexture
    )
      return unsupported(
        'GPU cube background requires native sky binding; use a Color or equirect background',
        scene.uuid,
      ).unwrap();
    const lighting =
      targetEnvironment === undefined
        ? this.environmentHandle(scene.environment, 1, uploadedTextures)
        : NO_EQUIRECT;
    const background =
      scene.background instanceof Color
        ? NO_EQUIRECT
        : this.environmentHandle(scene.background, scene.backgroundIntensity, uploadedTextures);
    const lightingRotation = new Quaternion().setFromEuler(scene.environmentRotation).toArray();
    const backgroundRotation = new Quaternion().setFromEuler(scene.backgroundRotation).toArray();
    if (!Number.isFinite(scene.environmentIntensity) || scene.environmentIntensity < 0)
      return invalid('Scene.environmentIntensity', scene.uuid).unwrap();
    return {
      lighting,
      background,
      lightingRotation,
      backgroundRotation,
      fog,
      ...(targetEnvironment === undefined ? {} : { targetEnvironment }),
    };
  }

  private environmentHandle(
    texture: Texture | null,
    intensity: number,
    uploadedTextures: Set<Texture>,
  ): AssetHandle<'equirect'> {
    if (texture === null) return NO_EQUIRECT;
    const version = textureValues(texture);
    const previous = this.environments.read(texture, version, 'radiance');
    const radiance =
      previous ??
      this.environments.write(
        texture,
        version,
        projectEnvironment(
          texture,
          this.environments.read(texture, undefined, 'radiance')?.payload,
        ),
        'radiance',
      );
    if (previous === undefined) recordUpload(uploadedTextures, texture);
    if (intensity === 1) return radiance.handle;
    const variant = 'background-scaled';
    const values = [radiance.payload, intensity];
    return (
      this.environments.read(texture, values, variant) ??
      this.environments.write(
        texture,
        values,
        scaleEnvironment(radiance.payload, intensity),
        variant,
      )
    ).handle;
  }

  private trackFrame(frame: ScenePreparation, settings: readonly unknown[]): void {
    let hasClipping = false;
    for (const node of frame.nodes) {
      if (node instanceof ClippingGroup) hasClipping = true;
      if (
        (node.renderOrder !== 0 && !localTransparentOrder(node)) ||
        node.children.some((child) => child.parent !== node)
      )
        return;
    }
    const witness = hasClipping
      ? clippingCandidates(frame.visible).find((object) =>
          unclippedWitness(object, frame.scene, frame.camera),
        )
      : undefined;
    if (hasClipping && !witness) return;
    const changes = new SceneChanges(
      frame.scene,
      settings,
      frame.camera.layers.mask,
      witness,
      frame.ecsPoses,
      frame.buffers.nativeTransparentOrder === true,
    );
    this.changes = changes;
    changes.index(frame.scene, (node) => this.trackNode(frame, changes, node));
  }

  private trackNode(
    frame: ScenePreparation,
    changes: SceneChanges,
    node: Object3D,
  ): boolean | 'view' {
    if (changes.unobservedNodeState.has(node)) return false;
    if (!node.visible) {
      if (!isRenderable(node) || !changes.watchDormant(node)) return false;
      const record = this.nodes.get(node);
      if (record && !record.meshCachePins) this.pinMeshCache(record);
      return true;
    }
    if (
      node instanceof AmbientLight ||
      node instanceof PointLight ||
      node instanceof SpotLight ||
      node instanceof RectAreaLight ||
      node instanceof DirectionalLight
    )
      return changes.watchLight(node, frame.buffers.shadowMap?.enabled === true);
    if (!isRenderable(node)) return changes.ordinaryGroup(node);
    if (
      node instanceof Sprite &&
      Object.getPrototypeOf(node) === Sprite.prototype &&
      Object.getPrototypeOf(node.material) === SpriteMaterial.prototype &&
      frame.buffers.nativeTransparentOrder &&
      this.options.world === undefined &&
      frame.spriteAdmissions?.get(node) === false &&
      changes.watchDeferredSprite(node)
    ) {
      changes.retainedSprites.add(node);
      return 'view';
    }
    const plan = frame.meshes.get(node);
    if (
      !plan?.materials.length ||
      !ordinaryGeometryReads(frame, node.geometry) ||
      frame.lists.clipping.has(node)
    )
      return false;
    const nativeSkin =
      node instanceof SkinnedMesh &&
      plan.skin?.kind === 'source' &&
      frame.ecsPoses &&
      frame.buffers.nativeTransparentOrder &&
      !frame.buffers.opaqueSort &&
      !frame.lists.groupOrders.has(node)
        ? plan.skin
        : undefined;
    if (plan.skin && !nativeSkin) return false;
    const layout = this.nodes.get(node)?.ordinaryMesh;
    const native =
      nativeSkin !== undefined || (!!layout && this.nativeViewMesh(frame, node, layout.source));
    if (!native && !trackableViewDraw(frame, node, plan)) return false;
    if (!changes.watchDraw(node, !native)) return false;
    if (nativeSkin && node instanceof SkinnedMesh) {
      if (
        !changes.watchNativeSkin(
          node,
          plan.materials.some((use) => use.skinProgram === 'standard'),
        )
      )
        return false;
      const release = this.skeletons.pin(node.skeleton, nativeSkin.variant);
      if (!release) return false;
      changes.hold(release);
    }
    if (!watchDrawMaterials(changes, node, plan, native, nativeSkin !== undefined)) return false;
    this.pinMeshCache(this.nodeRecord(node));
    if (native) return true;
    if (
      node instanceof Sprite &&
      frame.buffers.nativeTransparentOrder &&
      this.options.world === undefined
    )
      changes.retainedSprites.add(node);
    changes.viewDraws.set(node, {
      blended: plan.blended === true,
      rank: frame.lists.transparentRanks.get(node) ?? 0,
      depth:
        plan.blended && frame.buffers.sortObjects && !frame.buffers.nativeTransparentOrder
          ? sourceDepth(node, frame.camera, this.sortCenter)
          : undefined,
      live: true,
      zoom: frame.camera.projectionMatrix.elements[5],
      perspective: frame.camera.projectionMatrix.elements[11],
      pixelRatio: frame.buffers.pixelRatio ?? 1,
      // A point list with a fixed layout keeps its observed draw across content edits.
      republishPointContent:
        this.options.world === undefined &&
        frame.buffers.nativeTransparentOrder === true &&
        Object.getPrototypeOf(node) === Points.prototype &&
        hasPlainPointGeometry(node.geometry) &&
        plan.materials.length === 1,
    });
    return 'view';
  }

  private canReuseDrawView(frame: ScenePreparation): boolean {
    const changes = frame.changes;
    const nativeOrder = frame.buffers.nativeTransparentOrder === true;
    if (!changes?.reuseView(frame.camera, frame.buffers.pixelRatio ?? 1, nativeOrder)) return false;
    if (nativeOrder) return true;
    for (const object of changes.projectedPose) {
      if (!isRenderable(object)) continue;
      const draw = changes.viewDraws.get(object);
      if (!draw) continue;
      frame.viewPoseChecks++;
      if (!draw.live || !object.layers.test(frame.camera.layers)) return false;
      if (
        draw.blended &&
        frame.buffers.sortObjects &&
        draw.depth !== sourceDepth(object, frame.camera, this.sortCenter)
      )
        return false;
    }
    return true;
  }

  private walkScene(frame: ScenePreparation): void {
    if (frame.changes && this.canReuseDrawView(frame))
      frame.residualChildren = frame.changes.residualChildren();
    this.visit(frame, frame.scene, true, undefined, 0);
    if (frame.lists.pendingCasters.length && frame.changes)
      frame.shadowMask |= frame.changes.shadowCasterMask(frame.camera.layers.mask);
    for (const caster of frame.lists.pendingCasters) {
      if ((caster.layers.mask & frame.shadowMask) === 0) continue;
      this.validateObject(caster);
      frame.visible.add(caster);
    }
    // Scene owns ambient state even when its own layer does not match the camera.
    frame.nodes.add(frame.scene);
    this.validateObject(frame.camera);
    if (!frame.nodes.has(frame.camera)) {
      if (this.options.validateSource !== undefined) this.validateMountedNode(frame, frame.camera);
      frame.nodes.add(frame.camera);
    }
    if (
      !frame.changes &&
      this.options.validateSource !== undefined &&
      frame.visitedMounted < this.nodes.size
    ) {
      for (const [object, record] of this.nodes) {
        if (frame.nodes.has(object)) continue;
        this.assertRetirableNode(record);
        this.validateTransformParent(record);
        this.options.validateSource(object, record.entity);
      }
    }
  }

  private validateMountedNode(frame: ScenePreparation, object: Object3D): void {
    const record = this.nodes.get(object);
    if (record !== undefined) {
      this.assertRetirableNode(record);
      this.validateTransformParent(record);
      frame.visitedMounted++;
    }
    this.options.validateSource?.(object, record?.entity);
  }

  private visit(
    frame: ScenePreparation,
    object: Object3D,
    parentVisible: boolean,
    parentClipping: SourceClipping | undefined,
    groupOrder: number,
  ): void {
    if (this.options.validateSource !== undefined) this.validateMountedNode(frame, object);
    frame.nodes.add(object);
    const active = parentVisible && object.visible;
    const matched = active && object.layers.test(frame.camera.layers);
    const planes = matched ? objectClipping(object, parentClipping) : parentClipping;
    const order = matched && object instanceof Group ? object.renderOrder : groupOrder;
    if (order !== 0) frame.lists.groupOrders.set(object, order);
    if (planes !== undefined) frame.lists.clipping.set(object, planes);
    if (matched) {
      if (object instanceof LOD && object.autoUpdate) {
        const update = frame.changes?.lodUpdates.get(object);
        if (update) update(frame.camera);
        else object.update(frame.camera);
      }
      this.validateObject(object);
      if (
        frame.buffers.shadowMap?.enabled &&
        object.castShadow &&
        (object instanceof DirectionalLight ||
          object instanceof SpotLight ||
          object instanceof PointLight)
      ) {
        frame.shadowMask |= shadowCasterChannels(object, frame.camera.layers.mask);
      }
      frame.visible.add(object);
    } else if (
      active &&
      isRenderable(object) &&
      this.nativeViewMesh(
        frame,
        object,
        planes === undefined ? ordinaryMeshMaterial(frame, object, undefined) : undefined,
      )
    ) {
      this.validateObject(object);
      frame.visible.add(object);
    } else if (
      active &&
      frame.buffers.shadowMap?.enabled &&
      isRenderable(object) &&
      object.castShadow
    ) {
      frame.lists.pendingCasters.push(object);
    }
    const children = frame.changes
      ? (frame.residualChildren ?? frame.changes.children).get(object)
      : object.children;
    if (children) for (const child of children) this.visit(frame, child, active, planes, order);
  }

  private projectTransforms(frame: ScenePreparation): void {
    for (const object of frame.nodes) {
      if (frame.ecsPoses && !separateDrawPose(object)) continue;
      if (
        frame.buffers.nativeTransparentOrder &&
        this.options.world === undefined &&
        object instanceof Sprite &&
        frame.changes?.viewDraws.get(object)?.live === false &&
        !this.nativeRepairs.has(object)
      )
        continue;
      if (object !== frame.camera && !frame.visible.has(object)) {
        if (this.nodes.get(object)?.parent !== undefined)
          this.projectTransform(frame, object, false);
        continue;
      }
      this.projectTransform(frame, object);
    }
  }

  private localTransformParent(
    frame: ScenePreparation,
    object: Object3D,
    localVersion: number | undefined,
  ): Object3D | undefined {
    const parent = object.parent;
    if (
      parent === null ||
      object === frame.scene ||
      object instanceof Camera ||
      object instanceof Sprite ||
      object instanceof RectAreaLight ||
      !object.matrixAutoUpdate ||
      !object.matrixWorldAutoUpdate ||
      object.pivot !== null ||
      (!frame.nodes.has(parent) &&
        !(frame.changes?.residents.has(parent) && this.nodes.has(parent))) ||
      !parent.visible ||
      !parent.layers.test(frame.camera.layers)
    )
      return;
    if (!this.transformAnchorMatches(frame, parent)) return;

    // Tracked stock propagation already proved the source relationship. Strict
    // reads and overridden parent updates establish the same proof from matrices.
    if (localVersion === undefined) {
      const local = this.poseMatrix.compose(object.position, object.quaternion, object.scale);
      if (!sameValues(local.elements, matrixStorage(object.matrix.elements))) return;
      const expected = this.poseExpectedWorld.multiplyMatrices(parent.matrixWorld, local).elements;
      if (!sameValues(expected, matrixStorage(object.matrixWorld.elements))) return;
    }
    return parent;
  }

  private transformAnchorMatches(frame: ScenePreparation, parent: Object3D): boolean {
    let eligible = frame.lists.transformAnchors.get(parent);
    if (eligible === undefined) {
      eligible =
        !(parent instanceof Sprite || parent instanceof RectAreaLight) &&
        hasPositiveUniformSourceBasis(parent, parent === frame.camera);
      if (eligible && parent === frame.camera)
        eligible = stockCameraView(frame.camera, this.poseExpectedWorld).equals(
          frame.camera.matrixWorldInverse,
        );
      frame.lists.transformAnchors.set(parent, eligible);
    }
    return eligible;
  }

  private projectTransform(frame: ScenePreparation, object: Object3D, useWorld = true): void {
    const record = this.nodes.get(object);
    const localVersion = frame.changes?.resolvedLocalVersion(object);
    const sourceParent = object.parent;
    if (
      localVersion !== undefined &&
      record?.parent !== undefined &&
      record.localVersion === localVersion &&
      sourceParent !== null &&
      this.nodes.get(sourceParent)?.entity === record.parent &&
      sourceParent.visible &&
      sourceParent.layers.test(frame.camera.layers) &&
      (frame.nodes.has(sourceParent) || frame.changes?.residents.has(sourceParent)) &&
      this.transformAnchorMatches(frame, sourceParent)
    )
      return;

    const parent =
      frame.buffers.ecsPoses === undefined
        ? this.localTransformParent(frame, object, localVersion)
        : undefined;
    if (parent !== undefined) {
      const target = this.nodes.get(parent)?.entity;
      const relationChanged = target === undefined || target !== record?.parent;
      if (
        record?.parent !== undefined &&
        localVersion !== undefined &&
        record.localVersion === localVersion
      ) {
        if (relationChanged) frame.lists.transformParents.set(object, parent);
        return;
      }
      if (readLocalPose(object, this.poseScratch)) {
        if (relationChanged) frame.lists.transformParents.set(object, parent);
        if (record?.parent === undefined || !sameValues(record.transform, this.poseScratch))
          frame.lists.transforms.set(object, { pose: this.poseScratch.slice(), localVersion });
        else record.localVersion = localVersion;
        return;
      }
    }
    if (record?.parent !== undefined) frame.lists.transformParents.set(object, null);
    if (!useWorld) return;
    this.projectWorldTransform(frame, object, record);
  }

  private projectWorldTransform(
    frame: ScenePreparation,
    object: Object3D,
    record: NodeRecord | undefined,
  ): void {
    const camera = frame.camera;
    const previous = record?.parent === undefined ? record?.transform : undefined;
    let matrix = (object === camera ? camera.matrixWorldInverse : object.matrixWorld).elements;
    if (object instanceof Sprite) {
      const override =
        frame.scene instanceof Scene && object.material.allowOverride
          ? frame.scene.overrideMaterial
          : null;
      const material = override !== null && isSpriteMaterial(override) ? override : object.material;
      const positionMaterial =
        surfaceInput(object.material, 'positionNode') !== null ? object.material : material;
      if (this.spritePose.read(object, camera, material, positionMaterial, this.poseScratch)) {
        if (previous === undefined || !sameValues(previous, this.poseScratch))
          frame.lists.transforms.set(object, { pose: this.poseScratch.slice() });
        return;
      }
      matrix = spriteMatrix(object, camera, material, positionMaterial).elements;
    }
    const values = frame.changes ? matrixStorage(matrix) : matrix;
    const revision = object instanceof Bone ? sourceWorldRevision(object) : undefined;
    if (
      previous !== undefined &&
      (revision !== undefined
        ? record?.skinWorldRevision === revision
        : sameValues(previous, values))
    )
      return;
    frame.lists.transforms.set(object, decomposeSourceMatrix(object, camera, values, revision));
  }

  /** A published opaque mesh keeps its native binding as cameras move. Cold or
   * replaced assets still enter through source admission; arbitrary direct
   * material/geometry edits continue through the normal observation path. */
  private nativeViewMesh(
    frame: ScenePreparation,
    object: Renderable,
    material: Material | undefined,
  ): boolean {
    const layout = this.nodes.get(object)?.ordinaryMesh;
    if (
      layout === undefined ||
      material !== layout.source ||
      frame.buffers.opaqueSort != null ||
      !frame.buffers.sortObjects ||
      object.renderOrder !== 0 ||
      frame.lists.groupOrders.has(object) ||
      frame.lists.clipping.has(object)
    )
      return false;
    return (
      ownSourceValue(object, 'geometry') === layout.geometry.source &&
      ordinaryMeshSurface(material) &&
      (!isBlended(material) ||
        (frame.buffers.nativeTransparentOrder === true &&
          material instanceof MeshBasicMaterial &&
          material.map === null &&
          material.alphaMap === null &&
          !(frame.buffers.shadowMap?.enabled && object.castShadow)))
    );
  }

  private planMesh(
    frame: ScenePreparation,
    object: Renderable,
    planes: ClippingOptions | undefined,
  ): void {
    frame.planCalls++;
    if (
      object instanceof Sprite &&
      frame.spriteAdmissions?.get(object) !== true &&
      outsideThreeFrustum(frame, object)
    ) {
      frame.spriteAdmissions ??= new Map();
      frame.spriteAdmissions.set(object, false);
      return;
    }
    const sourceMaterial = object.material;
    const geometry = object.geometry;
    const original = ordinaryMeshMaterial(frame, object, planes, sourceMaterial);
    const shared = original === undefined ? undefined : frame.lists.sharedMeshPlans.get(geometry);
    const previous = original === undefined ? undefined : shared?.get(original);
    if (previous !== undefined) {
      previous.shareable ??= allowsSharedMeshPlan(frame, previous, geometry);
      if (previous.shareable) {
        rejectOrderedOpaque(frame, object, previous.materials);
        this.admitMesh(frame, object, previous);
        return;
      }
    }

    const plan =
      original !== undefined
        ? (this.reuseOrdinaryLayout(frame, object, original, geometry) ??
          this.projectDrawMesh(frame, object, geometry, sourceMaterial, planes))
        : this.projectDrawMesh(frame, object, geometry, sourceMaterial, planes);
    if (plan === undefined) return;
    this.admitMesh(frame, object, plan);
    if (original !== undefined && previous === undefined)
      registerOrdinaryMeshPlan(frame, plan, geometry, original, shared);
  }

  private admitMesh(frame: ScenePreparation, object: Renderable, plan: MeshPlan): void {
    frame.meshes.set(object, plan);
    plan.blended ??= plan.materials.some((use) => isBlended(use.effective));
    if (
      !frame.buffers.nativeTransparentOrder &&
      plan.blended &&
      object.layers.test(frame.camera.layers) &&
      !frame.repairRanks?.has(object)
    )
      frame.lists.transparentObjects.push(object);
  }

  private reuseOrdinaryLayout(
    frame: ScenePreparation,
    object: Renderable,
    material: Material,
    geometry: BufferGeometry,
  ): MeshPlan | undefined {
    const layout = this.nodes.get(object)?.ordinaryMesh;
    if (layout === undefined || frame.lists.clipping.has(object)) return undefined;
    const observation = reuseOrdinaryMaterial(frame, material, geometry, layout);
    if (observation === undefined) return undefined;
    const effective = observation.material;
    const untextured = layout.uv.coordinates.size === 0;
    const cached = untextured ? observation.untexturedMeshUses?.[layout.shading] : undefined;
    let materials = cached?.[0].variant === layout.variant ? cached : undefined;
    if (materials === undefined) {
      const coordinates = new Map<Texture, ResolvedMaterialTextureCoordinates>();
      const use: MaterialUse = {
        source: material,
        effective,
        observation,
        variant: layout.variant,
        shading: layout.shading,
        coordinates,
        skinProgram: undefined,
      };
      materials = [use];
      if (!sharedMaterialReads(use, observation)) return undefined;
      if (!untextured || useTextures(use).length !== 0) {
        // Recheck current channels and transforms. The general path remaps
        // and bakes UV streams when this mesh's projection changes.
        const uv = this.readMeshUvs(object, geometry, materials, coordinates);
        if (uv !== layout.uv) return undefined;
      }
    }
    const values = observeGeometry(frame, geometry, false);
    const asset = this.readMeshGeometry(frame, layout.geometry, values);
    if (asset.payload === undefined) return undefined;
    rejectOrderedOpaque(frame, object, materials);
    if (materials !== cached) {
      this.admitMaterialUse(frame, object, materials[0]);
      if (untextured) {
        observation.untexturedMeshUses ??= [];
        observation.untexturedMeshUses[layout.shading] = materials;
      }
    }
    return {
      geometry: layout.geometry,
      materials,
      asset,
      nativeInstances: false,
      ordinaryMesh: layout,
      shareable: true,
    };
  }

  private projectDrawMesh(
    frame: ScenePreparation,
    object: Renderable,
    sourceGeometry: BufferGeometry,
    sourceMaterial: Renderable['material'],
    planes: ClippingOptions | undefined,
  ): MeshPlan | undefined {
    const selection: GeometryMaterial[] = [];
    const list: MaterialUse[] = [];
    const coordinates = new Map<Texture, ResolvedMaterialTextureCoordinates>();
    selectMaterials(
      frame,
      object,
      sourceGeometry,
      sourceMaterial,
      planes,
      coordinates,
      selection,
      list,
    );
    const firstUse = list[0];
    if (firstUse === undefined) return;
    const wireframe = isWireframe(object, list);
    const skinned = object instanceof SkinnedMesh ? object : undefined;
    const skinPlan =
      skinned === undefined
        ? undefined
        : this.prepareSkinnedMaterialUses(frame, skinned, list, wireframe);
    const cpuSkin = skinPlan?.cpuSkin === true;
    rejectOrderedOpaque(frame, object, list);
    for (const use of list) validateThreeSurfaceGeometry(use.effective, sourceGeometry);
    const uv = this.readMeshUvs(object, sourceGeometry, list, coordinates);
    const resident = wireframe
      ? undefined
      : this.reuseOrdinaryMesh(
          frame,
          object,
          sourceGeometry,
          Array.isArray(sourceMaterial),
          list,
          selection,
          uv,
        );
    if (resident !== undefined) return resident;
    const instanceTint =
      object instanceof InstancedMesh && object.morphTexture === null
        ? this.instanceTints.common(object)
        : undefined;
    const shape: GeometryShape = {
      topology: wireframe ? 'line-list' : sourceTopology(object),
      grouped: Array.isArray(sourceMaterial),
      selection,
      wireframe,
      uv,
      flatMatcap: flatMatcapSlots(list),
      instanceTint,
      expanded:
        object instanceof BatchedMesh ||
        (object instanceof InstancedMesh &&
          (object.morphTexture !== null ||
            (object.instanceColor !== null && instanceTint === undefined))),
      cpuSkin,
      morphColor: projectsMorphColor(sourceGeometry, selection),
    };
    const instanceValues =
      object instanceof InstancedMesh ? instanceSourceValues(object, shape.expanded) : undefined;
    const instances = this.nativeInstanceTransforms(frame, object, instanceValues, shape.expanded);
    if (instances?.kind === 'replace' && instances.transforms.length === 0) return;
    const geometry = this.geometryPlan(object, sourceGeometry, shape);
    const sourceValues = geometryCacheValues(frame, object, sourceGeometry, shape);
    const cpuSkinSource = cpuSkin ? skinned : undefined;
    const values = shape.expanded
      ? [
          ...sourceValues,
          ...instanceGeometryValues(
            object as InstancedMesh | BatchedMesh,
            frame.camera,
            firstUse.effective,
            this.batchRosters,
          ),
        ]
      : cpuSkinSource === undefined
        ? sourceValues
        : [
            ...sourceValues,
            ...cpuSkinValues(cpuSkinSource, this.changes?.skinCursor(cpuSkinSource)),
          ];
    const asset = this.readMeshGeometry(frame, geometry, values, () =>
      this.projectMeshGeometry(frame, object, shape, geometry, cpuSkinSource, sourceValues),
    );
    if (asset.payload === undefined) return;
    const { payload } = asset;
    for (const use of list) this.admitMaterialUse(frame, object, use);
    const lines = meshLineStyle(object, payload, list, wireframe);
    if (lines === null) return;
    const skin =
      skinned !== undefined && !cpuSkin
        ? this.planSkin(skinned, payload, skinPlan?.nativeLitJoints, skinPlan?.sourceJoints)
        : undefined;
    const morphWeights = meshMorphWeights(object, payload);
    return {
      geometry,
      uv,
      materials: list,
      asset,
      nativeInstances: object instanceof InstancedMesh && !shape.expanded,
      instanceValues,
      instances,
      morphWeights,
      skin,
      lineStyle: lines,
      pointStyle: object instanceof Points ? pointStyle(object, frame, list) : undefined,
    };
  }

  private prepareSkinnedMaterialUses(
    frame: ScenePreparation,
    mesh: SkinnedMesh,
    list: MaterialUse[],
    wireframe: boolean,
  ) {
    const cursor = frame.ecsPoses ? undefined : this.changes?.skinCursor(mesh);
    const needsLitSkin = list.some((use) => use.skinProgram === undefined);
    const supportsLit = !wireframe && list.every((use) => nativeSkinMaterial(use));
    const sourceJoints =
      !needsLitSkin || supportsLit
        ? this.mountedSkinJoints(frame, mesh, needsLitSkin, cursor)
        : undefined;
    const nativeLitJoints =
      sourceJoints === undefined && needsLitSkin && supportsLit
        ? projectLitJoints(mesh, this.jointSnapshots, cursor ?? this.changes?.skinCursor(mesh))
        : undefined;
    const cpuSkin = needsLitSkin && sourceJoints === undefined && nativeLitJoints === undefined;
    for (const use of list) {
      use.skinProgram = cpuSkin ? undefined : (use.skinProgram ?? 'standard');
      use.variant += `:${use.skinProgram ?? 'cpu'}`;
    }
    return { cpuSkin, nativeLitJoints, sourceJoints };
  }

  private mountedSkinJoints(
    frame: ScenePreparation,
    mesh: SkinnedMesh,
    lit: boolean,
    cursor: SkinCursor | undefined,
  ) {
    // Attached bind cancels the mesh world transform. Detached or authored
    // matrices need the per-mesh correction in projectJoints.
    if (
      this.options.world !== undefined ||
      (!frame.ecsPoses && !frame.changes) ||
      mesh.bindMode !== AttachedBindMode
    )
      return;
    if (
      lit
        ? !canProjectLitSkin(mesh, cursor)
        : !canProjectAffinePoint(mesh, cursor) || mesh.matrixWorld.determinant() === 0
    )
      return;
    if (!frame.ecsPoses) {
      // A source callback can edit the usual attached-mode cancellation.
      if (!this.poseExpectedWorld.copy(mesh.matrixWorld).invert().equals(mesh.bindMatrixInverse))
        return;
    }
    const joints: EntityHandle[] = [];
    for (const bone of mesh.skeleton.bones) {
      const record = this.nodes.get(bone);
      if (!record || !(frame.changes?.members.has(bone) ?? frame.nodes.has(bone))) return;
      if (!frame.ecsPoses) {
        const revision = sourceWorldRevision(bone);
        if (revision === undefined || revision !== record.skinWorldRevision) return;
      }
      joints.push(record.sourcePose?.entity ?? record.entity);
    }
    return joints;
  }

  private readMeshUvs(
    object: Renderable,
    geometry: BufferGeometry,
    materials: readonly MaterialUse[],
    coordinates: Map<Texture, ResolvedMaterialTextureCoordinates>,
  ): UvProjection {
    let meshUvs = this.meshUvs.get(object);
    if (meshUvs === undefined) {
      meshUvs = new MeshUvs();
      this.meshUvs.set(object, meshUvs);
    }
    const textures = object instanceof Points ? [] : uvTextures(materials);
    const reservedChannels: number[] = [];
    if (textures.length > 0) {
      for (const use of materials) {
        for (const set of threeSurfaceUvSets(use.effective)) reservedChannels.push(set);
      }
    }
    const uv = meshUvs.read(geometry, textures, reservedChannels);
    for (const [texture, value] of uv.coordinates) coordinates.set(texture, value);
    if (uv.values.length > 0) {
      // Baked channels belong to the mesh's whole slot roster.
      for (const use of materials) {
        const remapped = useTextures(use).flatMap(([parameter, texture]) => {
          const set = coordinates.get(texture)?.set;
          return set !== undefined && set !== texture.channel ? [[parameter, set]] : [];
        });
        if (remapped.length > 0) use.variant += `:uv:${JSON.stringify(remapped)}`;
      }
    }
    return uv;
  }

  /** Keep source geometry across submissions while rebuilding uses from the current view. */
  private reuseOrdinaryMesh(
    frame: ScenePreparation,
    object: Renderable,
    sourceGeometry: BufferGeometry,
    grouped: boolean,
    materials: readonly MaterialUse[],
    selection: readonly GeometryMaterial[],
    uv: UvProjection,
  ): MeshPlan | undefined {
    const geometry = this.nodes.get(object)?.meshGeometry;
    const structure = geometry?.structure;
    if (
      geometry === undefined ||
      !structure?.shared ||
      structure.topology !== 'triangle-list' ||
      Object.getPrototypeOf(object) !== Mesh.prototype ||
      sourceGeometry !== geometry.source ||
      (object as Mesh).morphTargetInfluences !== undefined ||
      structure.grouped !== grouped ||
      uv.values.length !== 0 ||
      !sameValues(structure.generatedUvChannels, uv.generatedChannels) ||
      !matchesGeometrySelection(structure.selection, selection) ||
      materials.some((use) => use.shading === 1 && isMatcapMaterial(use.effective)) ||
      projectsMorphColor(geometry.source, selection)
    )
      return undefined;
    const values = observeGeometry(frame, geometry.source, structure.grouped);
    const asset = this.readMeshGeometry(frame, geometry, values, () => ({
      payload: projectGeometry(
        geometry.source,
        structure.grouped,
        structure.selection,
        structure.topology,
        uv.attributes,
      ).unwrap(),
    }));
    if (asset.payload === undefined || asset.payload.morphTargets !== undefined) return undefined;
    for (const use of materials) this.admitMaterialUse(frame, object, use);
    return {
      geometry,
      asset,
      materials,
      uv,
      nativeInstances: false,
    };
  }

  private geometryPlan(
    object: Renderable,
    source: BufferGeometry,
    shape: GeometryShape,
  ): MeshGeometryPlan {
    const candidate = this.nodes.get(object)?.meshGeometry;
    const shared =
      !shape.expanded &&
      !shape.cpuSkin &&
      !shape.morphColor &&
      shape.flatMatcap.size === 0 &&
      shape.uv.values.length === 0;
    const generatedUvChannels = shape.uv.generatedChannels;
    if (
      candidate?.source === source &&
      matchesGeometryStructure(candidate.structure, shape, generatedUvChannels)
    )
      return candidate;
    return {
      source,
      variant: geometryVariant(object, shape),
      structure: {
        topology: shape.topology,
        grouped: shape.grouped,
        wireframe: shape.wireframe,
        selection: shape.selection,
        generatedUvChannels,
        uvValues: shape.uv.values,
        flatMatcap: shape.flatMatcap,
        expanded: shape.expanded,
        instanceTint: shape.instanceTint,
        cpuSkin: shape.cpuSkin,
        morphColor: shape.morphColor,
        shared,
      },
    };
  }

  private readMeshGeometry(
    frame: ScenePreparation,
    geometry: MeshGeometryPlan,
    values: readonly unknown[],
    project?: () => MeshGeometryProjection | undefined,
  ): MeshGeometryAsset {
    // Shared structural projections have the same immutable source observation.
    let variants = geometry.structure.shared
      ? frame.lists.meshAssets.get(geometry.source)
      : undefined;
    const prior = variants?.get(geometry.variant);
    if (prior !== undefined && prior.values === values) return prior;

    const published = this.geometry.read(geometry.source, values, geometry.variant);
    const projection: MeshGeometryProjection | undefined = published ?? project?.();
    const asset: MeshGeometryAsset = {
      values,
      acceptedValues: published?.values,
      payload: projection?.payload,
      sourceData: projection?.sourceData,
      pointEdit: projection?.pointEdit,
      handle: undefined,
    };
    if (projection !== undefined && geometry.structure.shared) {
      if (variants === undefined) {
        variants = new Map();
        frame.lists.meshAssets.set(geometry.source, variants);
      }
      variants.set(geometry.variant, asset);
    }
    return asset;
  }

  /** Content changes reuse the submitted point geometry, style and material roster. */
  private preparePointRevision(
    frame: ScenePreparation,
    object: Renderable,
    channels: PointContentChannels,
  ): boolean {
    const record = this.nodeRecord(object);
    const geometry = record.meshGeometry;
    if (
      geometry?.source !== object.geometry ||
      !record.binding?.mesh ||
      this.geometry.sourceData(geometry.source, geometry.variant) !== POINT_CONTENT
    )
      return false;
    const content = readPointContent(
      geometry.source,
      geometry.structure.selection[0]?.vertexColors === true,
    );
    if (content === undefined) return false;
    const accepted = this.geometry.previous(geometry.source, geometry.variant);
    if (accepted === undefined) return false;
    const asset = this.readMeshGeometry(
      frame,
      geometry,
      observeGeometry(frame, geometry.source, false),
      () => {
        const payload = runtimeAssets(this.assets).borrow<MeshAsset>(accepted.handle).unwrap();
        if (
          payload.attributeStorage !== 'interleaved' ||
          payload.indices?.length !== content.count ||
          (payload.attributes.color !== undefined) !== (content.color !== undefined)
        )
          return;
        return {
          payload,
          sourceData: POINT_CONTENT,
          pointEdit: { ...pointContentEdit(content, channels), base: accepted.values },
        };
      },
    );
    if (asset.payload === undefined) return false;
    frame.pointRevisions ??= [];
    frame.pointRevisions.push({ record, geometry, asset });
    return true;
  }

  private repackAcceptedPointContent(
    geometry: MeshGeometryPlan,
    content: NonNullable<ReturnType<typeof readPointContent>>,
    channels?: PointContentChannels,
  ): MeshAsset | undefined {
    const accepted = this.geometry.previous(geometry.source, geometry.variant);
    if (accepted === undefined) return undefined;
    return repackPointContent(
      content,
      runtimeAssets(this.assets).borrow<MeshAsset>(accepted.handle).unwrap(),
      geometry.source,
      channels,
    );
  }

  private projectMeshGeometry(
    frame: ScenePreparation,
    object: Renderable,
    shape: GeometryShape,
    geometry: MeshGeometryPlan,
    cpuSkin: SkinnedMesh | undefined,
    sourceValues: readonly unknown[],
  ): { payload: MeshAsset | undefined; sourceData?: GeometrySourceData | undefined } {
    const previous = this.geometry.sourceData(geometry.source, geometry.variant);
    if (
      this.options.world === undefined &&
      Object.getPrototypeOf(object) === Points.prototype &&
      !shape.grouped &&
      shape.selection.length === 1 &&
      shape.selection[0]?.slot === 0 &&
      shape.uv.generatedChannels.length === 0 &&
      shape.flatMatcap.size === 0 &&
      ordinaryGeometryReads(frame, geometry.source)
    ) {
      const content = readPointContent(geometry.source, shape.selection[0].vertexColors);
      if (content !== undefined) {
        const payload =
          previous === POINT_CONTENT
            ? this.repackAcceptedPointContent(geometry, content)
            : undefined;
        return {
          payload: payload ?? projectSourceMesh(object, geometry.source, shape, true),
          sourceData: POINT_CONTENT,
        };
      }
    }
    if (shape.expanded) {
      const base =
        previous?.kind === 'instances' && sameValues(previous.values, sourceValues)
          ? previous.geometry
          : projectSourceMesh(object, geometry.source, shape, false);
      if (base === undefined) return { payload: undefined };
      return {
        payload: finishMeshGeometry(object, shape, base),
        sourceData: { kind: 'instances', values: sourceValues, geometry: base },
      };
    }
    if (cpuSkin === undefined) {
      let base = projectSourceMesh(
        object,
        geometry.source,
        shape,
        shape.instanceTint === undefined,
      );
      if (base !== undefined && shape.instanceTint !== undefined)
        base = tintInstanceGeometry(base, shape.instanceTint);
      return { payload: finishMeshGeometry(object, shape, base) };
    }

    let sourceData = previous;
    if (sourceData?.kind !== 'skin' || !sameValues(sourceData.values, sourceValues)) {
      const base = projectSourceMesh(object, geometry.source, shape, false);
      if (base === undefined) return { payload: undefined };
      sourceData = { kind: 'skin', values: sourceValues, geometry: cpuSkinGeometry(base) };
    }
    return {
      sourceData,
      payload: finishMeshGeometry(object, shape, projectCpuSkin(cpuSkin, sourceData.geometry)),
    };
  }

  /** Source matrices change only with their version; undefined keeps the published transforms. */
  private nativeInstanceTransforms(
    frame: ScenePreparation,
    object: Renderable,
    instanceValues: readonly unknown[] | undefined,
    expanded: boolean,
  ): NativeInstanceChange | undefined {
    if (!(object instanceof InstancedMesh) || instanceValues === undefined || expanded)
      return undefined;
    const record = this.nodes.get(object);
    const previous = record?.instances;
    if (previous !== undefined && sameValues(previous, instanceValues)) return undefined;
    const attribute = object.instanceMatrix;
    const lanes = object.count * 16;
    if (
      record?.nativeInstanceCount === object.count &&
      previous?.[0] === attribute &&
      previous[1] === attribute.array &&
      previous[2] === attribute.version - 1 &&
      previous[3] === object.count &&
      previous[4] === false &&
      attribute.array instanceof Float32Array
    ) {
      const backing = attribute.array.buffer;
      const borrow =
        this.options.world === undefined &&
        frame.buffers.transparentSort == null &&
        frame.buffers.opaqueSort == null &&
        Object.getPrototypeOf(object) === InstancedMesh.prototype &&
        backing instanceof ArrayBuffer &&
        !('resizable' in backing && backing.resizable);
      const ranges = sparseInstanceTransforms(object, attribute.array, lanes, borrow);
      if (ranges !== undefined) {
        if (!borrow) return { kind: 'patch', ranges };
        const ticket: Extract<NativeInstanceChange, { kind: 'borrowed' }> = { kind: 'borrowed' };
        const version = attribute.version;
        const array = attribute.array;
        frame.borrowedInstanceWindows ??= [];
        frame.borrowedInstanceWindows.push(() => {
          if (
            object.instanceMatrix !== attribute ||
            attribute.array !== array ||
            attribute.version !== version ||
            object.count * 16 !== lanes ||
            array.length < lanes
          )
            invalid(
              'InstancedMesh.instanceMatrix changed during publication',
              object.uuid,
            ).unwrap();
          ticket.write = ranges.every(
            ({ values }) => compactNativeInstances(object, values, false) === values.length,
          )
            ? { kind: 'patch', ranges }
            : {
                kind: 'replace',
                transforms: projectNativeInstanceTransforms(object, array.subarray(0, lanes)),
              };
        });
        return ticket;
      }
    }
    return {
      kind: 'replace',
      transforms: projectNativeInstanceTransforms(object, attribute.array.subarray(0, lanes)),
    };
  }

  private planSkin(
    object: SkinnedMesh,
    payload: MeshAsset,
    joints?: ReturnType<typeof projectJoints>,
    sourceJoints?: readonly EntityHandle[],
  ): NonNullable<MeshPlan['skin']> {
    const cursor =
      sourceJoints === undefined || this.ecsPoseChanges === undefined
        ? this.changes?.skinCursor(object)
        : undefined;
    const values = cursor?.owner.binding ? [cursor.owner.binding] : skinValues(object),
      variant = JSON.stringify(object.bindMatrix.elements);
    const skeleton =
      this.skeletons.read(object.skeleton, values, variant) ??
      this.skeletons.write(object.skeleton, values, projectSkeleton(object), variant);
    if (payload.attributes.skinIndex === undefined || payload.attributes.skinWeight === undefined)
      invalid('SkinnedMesh skinIndex/skinWeight', object.uuid).unwrap();
    const indices = payload.attributes.skinIndex;
    if (indices instanceof Uint16Array) {
      let maximum = this.maximumJointIndices.get(indices);
      if (maximum === undefined) {
        maximum = 0;
        for (const joint of indices) maximum = Math.max(maximum, joint);
        this.maximumJointIndices.set(indices, maximum);
      }
      if (maximum >= object.skeleton.bones.length)
        invalid('SkinnedMesh joint index', object.uuid).unwrap();
    }
    if (sourceJoints !== undefined)
      return {
        kind: 'source',
        skeleton: skeleton.handle,
        affinePoint: true,
        joints: sourceJoints,
        variant,
      };
    return {
      kind: 'projected',
      skeleton: skeleton.handle,
      affinePoint: joints !== undefined || canProjectAffinePoint(object, cursor),
      joints: joints ?? projectJoints(object, this.jointSnapshots, cursor),
      patch: this.jointSnapshots.get(object)?.patch,
    };
  }

  /** Validate one selected material against its draw and plan its source textures. */
  private admitMaterialUse(frame: ScenePreparation, object: Renderable, use: MaterialUse): void {
    const source = use.effective;
    if (!(object instanceof Points) && source.type === 'PointsNodeMaterial')
      unsupported(
        'PointsNodeMaterial requires Points; other topologies need native point sizing',
        object.uuid,
      ).unwrap();
    if (!(object instanceof Sprite) && source.type === 'SpriteNodeMaterial')
      unsupported('SpriteNodeMaterial requires a Sprite billboard', object.uuid).unwrap();
    if (use.clipping !== undefined && (object instanceof Line || object instanceof Points))
      unsupported('Native Lines/Points support camera clipping only', object.uuid).unwrap();
    if (frame.lists.clipping.get(object) !== undefined && source.alphaToCoverage)
      unsupported(
        'ClippingGroup alphaToCoverage requires native smooth clipping coverage',
        object.uuid,
      ).unwrap();
    if (object instanceof Line || object instanceof Points)
      projectLinePointMaterial(object, source, use.coordinates);
    if (isNormalMaterial(source) && !object.geometry.hasAttribute('normal'))
      unsupported('Normal/Matcap without normals requires flat shading', object.uuid).unwrap();
    frame.lists.usedMaterials[use.shading].add(use);
    for (const [parameter, texture] of useTextures(use)) {
      const projection = textureProjection(source, parameter, texture);
      if (isExternalTexture(texture)) {
        if (frame.buffers.externalDemand !== undefined && !this.external?.hasCurrent(texture))
          frame.buffers.externalDemand.add(texture);
        continue;
      }
      if (texture.isRenderTargetTexture) continue;
      let plans = frame.lists.texturePlans[projection];
      if (plans === undefined) {
        plans = new Map();
        frame.lists.texturePlans[projection] = plans;
      }
      if (!plans.has(texture)) {
        const canvas = projection === 0 ? this.planCanvasTexture(texture) : undefined;
        plans.set(texture, canvas ?? this.planTexture(texture, projection));
      }
    }
  }

  /** Admit only this texture; no scene discovery, entity writes, or hidden render. */
  prepareTexture(texture: Texture): { handle: AssetHandle<'texture'>; uploaded: boolean } {
    const cache = this.textures[0];
    cache.begin();
    try {
      const result = runtimeAssets(this.world.assets)
        .adoptClosure(() => {
          const plan = this.planTexture(texture, 0);
          const previous = cache.readHandle(
            texture,
            plan.values,
            plan.variant,
            plan.acceptedTexture,
          );
          const handle = previous ?? cache.write(texture, plan.values, plan.payload).handle;
          cache.retain(texture);
          return ok({
            handle,
            uploaded: previous === undefined || this.textureUpdates.has(texture),
          });
        })
        .unwrap();
      // Explicit preparation must not sweep textures used by the last scene frame.
      cache.commit(false);
      return result;
    } catch (error) {
      cache.abort();
      throw error;
    }
  }

  textureInitialized(texture: Texture, uploaded: boolean): void {
    if (uploaded && !textureUploadPending(texture)) {
      this.textureUpdates.delete(texture);
      texture.onUpdate?.(texture);
    }
  }

  private readonly hasAcceptedTextureSnapshot = (texture: Texture): boolean =>
    this.textures[0].readHandle(texture, textureValues(texture), '', undefined) !== undefined;

  private planCanvasTexture(texture: Texture): CanvasTexturePlan | undefined {
    const canvas = this.canvasTextures?.prepare(texture, this.hasAcceptedTextureSnapshot);
    if (canvas === undefined) return;
    const values = samplerValues(texture);
    const previous = this.samplers.read(texture, values);
    return {
      source: texture,
      canvas,
      sampler: previous?.payload ?? projectSampler(texture).unwrap(),
      samplerValues: values,
      acceptedSampler: previous?.values,
    };
  }

  private planTexture(texture: Texture, projection: TextureProjection): AssetTexturePlan {
    const [orientation, variant] = textureProjectionSlots[projection];
    validateTexture(texture).unwrap();
    if (
      orientation === 1 &&
      texture.matrix.elements.some((value, index) => value !== (index % 4 === 0 ? 1 : 0))
    )
      unsupported('Matcap Texture UV transform', texture.uuid).unwrap();
    const values = textureValues(texture),
      samplerSignature = samplerValues(texture);
    const previous = this.textures[orientation].read(texture, values, variant);
    const sampler = this.samplers.read(texture, samplerSignature);
    const raw =
      previous?.payload ??
      projectTextureUpload(
        texture,
        this.textures[orientation].read(texture, undefined, variant)?.payload,
        orientation === 1 ? !texture.flipY : texture.flipY,
      ).unwrap();
    return {
      orientation,
      variant,
      source: texture,
      values,
      samplerValues: samplerSignature,
      acceptedTexture: previous?.values,
      acceptedSampler: sampler?.values,
      payload:
        previous?.payload ??
        (variant === '' ? raw : expandScalarTexture(raw, variant === 'scalar-color')),
      sampler: sampler?.payload ?? projectSampler(texture).unwrap(),
    };
  }

  private publishTextures(frame: ScenePreparation): TextureBindings {
    const textureBindings = frame.lists.textureBindings;
    for (let projection = 0; projection < frame.lists.texturePlans.length; projection++) {
      const plans = frame.lists.texturePlans[projection];
      if (plans === undefined) continue;
      let bindings = textureBindings[projection];
      if (bindings === undefined) {
        bindings = new Map();
        textureBindings[projection] = bindings;
      }
      for (const plan of plans.values()) {
        const sampler =
          this.samplers.readHandle(plan.source, plan.samplerValues, '', plan.acceptedSampler) ??
          this.samplers.write(plan.source, plan.samplerValues, plan.sampler).handle;
        if ('canvas' in plan) {
          bindings.set(plan.source, { source: plan.canvas, sampler });
          continue;
        }
        const cache = this.textures[plan.orientation];
        const previous = cache.readHandle(
          plan.source,
          plan.values,
          plan.variant,
          plan.acceptedTexture,
        );
        const texture =
          previous ?? cache.write(plan.source, plan.values, plan.payload, plan.variant).handle;
        if (previous === undefined) recordUpload(frame.lists.uploadedTextures, plan.source);
        bindings.set(plan.source, { texture, sampler });
      }
    }
    return textureBindings;
  }

  private publishMaterials(frame: ScenePreparation, textureBindings: TextureBindings): void {
    const bindings: MaterialTextureValue[] = [];
    const signature: unknown[] = [];
    for (const shading of [0, 1] as const) {
      for (const use of frame.lists.usedMaterials[shading]) {
        const source = use.effective;
        const observation = use.observation;
        const textures = useTextures(use);
        const key = `${shading}:${use.variant}`;
        const shareable =
          observation !== undefined &&
          textures.every(
            ([, texture]) => !texture.isRenderTargetTexture && !isExternalTexture(texture),
          );
        const priorUse = shareable ? observation.published?.get(key) : undefined;
        if (priorUse !== undefined && sameMaterialCoordinates(priorUse.use, use)) {
          frame.lists.materialPublications.set(use, priorUse.asset);
          continue;
        }
        const expression =
          observation === undefined ? observeThreeSurfaceInputs(source) : undefined;
        let base = observation?.values;
        if (base === undefined) {
          base = materialValues(
            source,
            observation?.sharedMesh === true ? observation.surface : undefined,
            expression ?? null,
          );
          if (observation !== undefined) observation.values = base;
        }
        signature.length = 0;
        bindings.length = 0;
        for (const [parameter, texture] of textures) {
          const binding = this.textureBinding(use, parameter, texture, textureBindings);
          bindings.push(binding);
          appendBindingValues(signature, parameter, binding, use.coordinates.get(texture));
        }
        const cache = this.materials[shading];
        const existing = cache.read(use.source, base, use.variant, signature);
        const published =
          existing ??
          this.publishMaterialChange(cache, use, base, signature, textures, bindings, expression);
        if (published.sourceData === undefined) throw new Error('material has no source lease');
        const asset = { handle: published.handle, address: published.sourceData.address };
        if (shareable) {
          observation.published ??= new Map();
          observation.published.set(key, { use, asset });
        }
        frame.lists.materialPublications.set(use, asset);
      }
    }
  }

  private publishMaterialChange(
    cache: SharedAssets<Material, MaterialAsset, MaterialDependencies>,
    use: MaterialUse,
    base: readonly unknown[],
    signature: readonly unknown[],
    textures: ReturnType<typeof materialTextures>,
    bindings: readonly MaterialTextureValue[],
    expression: SurfaceInputObservation | undefined,
  ) {
    const values = [...base, ...signature];
    const previous =
      use.observation === undefined && expression === undefined
        ? undefined
        : cache.previous(use.source, use.variant);
    const dependencies = cache.sourceData(use.source, use.variant);
    const parameterPatch =
      previous === undefined
        ? undefined
        : materialParameterPatch(previous.values, values, base.length, values.length, expression);
    const stock =
      use.observation?.sharedMesh === true &&
      use.source === use.effective &&
      use.skinProgram === undefined &&
      use.clipping === undefined &&
      textures.length === 0 &&
      plainStockMaterial(use.source);
    let payload: MaterialAsset;
    let createdHandle: AssetHandle<'material'> | undefined;
    const template =
      stock && previous === undefined ? this.reuseStockDefinition(cache, use, values) : undefined;
    if (template !== undefined) {
      createdHandle = this.assets.copy(template.handle).unwrap();
      payload =
        Object.keys(template.patch).length === 0
          ? runtimeAssets(this.assets).borrow<MaterialAsset>(createdHandle).unwrap()
          : this.patchMaterialValues(createdHandle, template.patch);
    } else if (previous !== undefined && parameterPatch !== undefined) {
      payload = this.patchMaterialValues(previous.handle, parameterPatch);
    } else {
      const bindingStart = base.length + 1;
      const bindingPatch =
        previous !== undefined && sameTextureSlots(dependencies, textures, bindings)
          ? materialParameterPatch(previous.values, values, base.length, bindingStart, expression)
          : undefined;
      const resolved = resolveMaterialBindings(
        use,
        textures,
        bindings,
        bindingPatch === undefined || previous === undefined
          ? undefined
          : (slot) => sameBindingValues(previous.values, values, bindingStart, slot),
      );
      payload =
        previous !== undefined && bindingPatch !== undefined
          ? this.patchMaterialValues(previous.handle, { ...bindingPatch, ...resolved })
          : this.projectMaterialUse(use, resolved, use.shading, expression);
    }
    const published = cache.write(
      use.source,
      values,
      payload,
      use.variant,
      parameterPatch !== undefined && dependencies !== undefined
        ? dependencies
        : {
            address: dependencies?.address ?? {
              source: use.source,
              variant: use.variant,
              shading: use.shading,
            },
            surfaceInputs: surfaceParameterSlots(expression, base.length),
            textures: textures.map(([parameter, texture], index) => ({
              parameter,
              source: texture,
              projection:
                typeof bindings[index]?.texture === 'number'
                  ? textureProjection(use.effective, parameter, texture)
                  : undefined,
              canvas: canvasBindingSource(bindings[index]),
            })),
          },
      createdHandle,
    );
    if (stock && previous === undefined && template === undefined) {
      if (this.stockDefinitions.length === 16) this.stockDefinitions.shift();
      this.stockDefinitions.push({
        source: new WeakRef(use.source),
        variant: use.variant,
        shading: use.shading,
      });
    }
    return published;
  }

  private reuseStockDefinition(
    cache: SharedAssets<Material, MaterialAsset, MaterialDependencies>,
    use: MaterialUse,
    values: readonly unknown[],
  ) {
    for (let index = this.stockDefinitions.length - 1; index >= 0; index--) {
      const entry = this.stockDefinitions[index];
      if (entry === undefined || entry.variant !== use.variant || entry.shading !== use.shading)
        continue;
      const source = entry.source.deref();
      if (source === undefined || source === use.source) continue;
      const accepted = cache.previous(source, entry.variant);
      if (accepted === undefined) continue;
      const patch = stockMaterialParameterPatch(accepted.values, values, values.length, true);
      if (patch !== undefined) return { handle: accepted.handle, patch };
    }
    return undefined;
  }

  private publishMaterialEdits(changes: SceneChanges): void {
    for (const [source, dirty] of changes.materialEdits) {
      const uses = changes.uses.get(source);
      if (!uses) continue;
      const updated = uses.size > 1 ? new Set<AssetHandle<'material'>>() : undefined;
      for (const use of uses.values()) {
        if (use.view && !use.direct) continue;
        if (use.view) {
          let active = false;
          for (const mesh of use.meshes) {
            if (changes.viewDraws.get(mesh)?.live) {
              active = true;
              break;
            }
          }
          if (!active) continue;
        }
        const cache = this.materials[use.shading];
        const accepted = cache.previous(source, use.variant);
        if (accepted === undefined || updated?.has(accepted.handle)) continue;
        updated?.add(accepted.handle);
        const inputs = cache.sourceData(source, use.variant)?.surfaceInputs;
        const patch: Record<string, MaterialValue> = {};
        const edits = new Map<number, unknown>();
        for (const key of dirty) {
          const input = typeof key === 'number' ? inputs?.[key] : { name: key };
          if (!input) throw new Error('tracked Surface lost its parameter offset');
          const { name } = input;
          const { offset, value } =
            'offset' in input
              ? { offset: input.offset, value: readThreeSurfaceInput(source, key as number) }
              : readStockMaterialEdit(
                  source as MeshBasicMaterial | MeshStandardMaterial | SpriteMaterial,
                  input.name,
                );
          if (typeof value === 'number') {
            if (!Object.is(accepted.values[offset], value)) {
              edits.set(offset, value);
              patch[name] = value;
            }
            continue;
          }
          for (let index = 0; index < value.length; index++) {
            const lane = offset + index;
            if (!Object.is(accepted.values[lane], value[index])) {
              edits.set(lane, value[index]);
              patch[name] = value;
            }
          }
        }
        if (edits.size) {
          this.assets
            .update<'material', MaterialAsset>(accepted.handle, { values: patch })
            .unwrap();
          cache.editSignature(source, use.variant, edits);
        }
      }
    }
    changes.materialEdits.clear();
  }

  private patchMaterialValues(
    handle: AssetHandle<'material'>,
    values: Readonly<Record<string, MaterialValue>>,
  ): MaterialAsset {
    this.assets.update<'material', MaterialAsset>(handle, { values }).unwrap();
    return runtimeAssets(this.assets).borrow<MaterialAsset>(handle).unwrap();
  }

  private textureBinding(
    use: MaterialUse,
    parameter: string,
    texture: Texture,
    textureBindings: TextureBindings,
  ): MaterialTextureValue {
    const binding =
      isExternalTexture(texture) || texture.isRenderTargetTexture
        ? ({
            ...((texture.isRenderTargetTexture
              ? this.options.targets?.binding(texture)
              : this.external?.binding(texture)) ??
              unsupported(
                'External texture requires a renderer import lease',
                texture.uuid,
              ).unwrap()),
            sampler: (
              this.samplers.read(texture, samplerValues(texture)) ??
              this.samplers.write(texture, samplerValues(texture), projectSampler(texture).unwrap())
            ).handle,
            coordinates: use.coordinates.get(texture),
          } as MaterialTextureValue)
        : textureBindings[textureProjection(use.effective, parameter, texture)]?.get(texture);
    if (binding === undefined)
      throw new Error('admitted texture missing its managed asset reference');
    return binding;
  }

  private projectMaterialUse(
    use: MaterialUse,
    bindings: Record<string, MaterialTextureValue>,
    shading: 0 | 1,
    expression: SurfaceInputObservation | undefined,
  ): MaterialAsset {
    const source = use.effective;
    let projected = projectMaterial(
      source,
      bindings,
      shading === 1,
      false,
      expression,
      use.observation?.sharedMesh ? use.observation.surface : undefined,
    ).unwrap();
    if (use.clipping !== undefined) projected = withClipping(projected, use.clipping);
    if (use.skinProgram === 'standard') {
      const [first, ...rest] = projected.passes ?? [];
      if (projected.parent !== undefined || first === undefined)
        throw new Error('Standard skin material requires root passes');
      const skinPass = (pass: typeof first) =>
        pass.program.module === 'forgeax_material::standard'
          ? { ...pass, program: { ...pass.program, module: 'forgeax::pbr-skin' } }
          : pass;
      projected = { ...projected, passes: [skinPass(first), ...rest.map(skinPass)] };
    }
    if (this.prepareMaterialPrograms !== undefined)
      projected = this.prepareMaterialPrograms(projected, use.skinProgram === 'unlit');
    return projected;
  }

  private publishGeometry(frame: ScenePreparation): void {
    frame.meshes.forEach((plan) => {
      this.publishMeshAsset(frame, plan);
    });
    if (frame.pointRevisions)
      for (const revision of frame.pointRevisions) this.publishMeshAsset(frame, revision);
  }

  private publishMeshAsset(
    frame: ScenePreparation,
    { asset, geometry }: Pick<MeshPlan, 'geometry' | 'asset'>,
  ): void {
    if (asset.handle !== undefined) return;
    if (asset.payload === undefined) throw new Error('admitted mesh has no geometry');
    const cache = this.geometry;
    const pointEdit = asset.pointEdit;
    const retained = cache.previous(geometry.source, geometry.variant);
    if (pointEdit !== undefined && retained?.values === pointEdit.base) {
      if (pointEdit.ranges.length !== 0) {
        frame.meshRanges ??= [];
        frame.meshRanges.push({ handle: retained.handle, input: pointEdit.ranges });
      }
      cache.editSignature(geometry.source, geometry.variant, asset.values);
      asset.handle = retained.handle;
      return;
    }
    // A disposal during later material preparation can invalidate the lease.
    if (retained !== undefined && retained.values === asset.acceptedValues) {
      asset.handle = retained.handle;
      return;
    }
    const cached = cache.read(geometry.source, asset.values, geometry.variant);
    if (cached !== undefined) {
      asset.handle = cached.handle;
      return;
    }
    const payload =
      pointEdit === undefined
        ? asset.payload
        : repackPointContent(pointEdit.content, asset.payload, geometry.source, pointEdit.channels);
    if (payload === undefined) throw new Error('point content layout changed during publication');
    const entry = cache.write(
      geometry.source,
      asset.values,
      payload,
      geometry.variant,
      asset.sourceData,
    );
    asset.handle = entry.handle;
  }

  private publishTransforms(frame: ScenePreparation): void {
    for (const object of frame.nodes) if (!this.nodes.has(object)) this.spawnNode(object);
    this.commitTransformParents(frame);
    const retired: Object3D[] = [];
    if (frame.changes) {
      for (const node of frame.changes.retired) {
        if (!frame.changes.members.has(node) && !frame.nodes.has(node)) retired.push(node);
      }
      const previous = this.previousCamera;
      if (
        previous &&
        previous !== frame.camera &&
        !frame.changes.members.has(previous) &&
        !frame.nodes.has(previous) &&
        !frame.changes.retired.has(previous)
      )
        retired.push(previous);
    } else {
      for (const object of this.nodes.keys()) if (!frame.nodes.has(object)) retired.push(object);
    }
    for (const object of retired) {
      const record = this.nodes.get(object);
      if (record) this.detachTransformParent(record);
    }
    for (const object of retired) {
      const record = this.nodes.get(object);
      if (record === undefined) continue;
      this.releaseNode(record);
      this.nodes.delete(object);
      if (isRenderable(object)) this.meshUvs.delete(object);
    }
    for (const [object, transform] of frame.lists.transforms)
      this.commitTransform(this.nodeRecord(object), transform);
    if (this.options.propagate !== false) propagateTransforms(this.world).unwrap();
  }

  private commitDraws(
    frame: ScenePreparation,
    lighting: SceneLighting,
    ambientIrradiance: [number, number, number],
    cameraData: CameraData,
  ): void {
    if (
      !frame.changes ||
      this.committedLighting?.data !== lighting ||
      !sameValues(this.committedLighting.ambient, ambientIrradiance)
    ) {
      this.writeSceneLighting(frame.scene, lighting, ambientIrradiance);
      this.committedLighting =
        this.plainLighting?.data === lighting
          ? { data: lighting, ambient: ambientIrradiance }
          : undefined;
    }
    if (frame.changes) {
      for (const [object, rank] of frame.lists.transparentRanks) {
        const draw = isRenderable(object) ? frame.changes.viewDraws.get(object) : undefined;
        if (draw) draw.rank = rank;
        if (frame.nodes.has(object)) continue;
        const record = this.nodeRecord(object);
        this.write(record.entity, Layer, { value: rank });
        if (record.binding) record.binding.layer = rank;
      }
    }
    for (const [record, handle] of frame.spriteFilters ?? []) {
      this.write(record.entity, MeshFilter, { assetHandle: handle });
      if (record.binding) record.binding.mesh = handle;
    }
    for (const object of frame.nodes) this.writeNode(frame, object, this.nodeRecord(object));
    const changes = frame.changes;
    if (changes?.nodeState.size) {
      for (const [object, fields] of changes.nodeState) {
        const record = this.nodes.get(object);
        if (record?.renderReady && changes.members.has(object))
          this.writeNodeState(
            object,
            record.entity,
            fields,
            this.options.world === undefined && !changes.unobservedNodeState.has(object),
          );
      }
      changes.nodeState.clear();
    }
    let skinPoseUpdated = false;
    frame.meshes.forEach((plan, object) => {
      const record = this.nodeRecord(object);
      skinPoseUpdated ||= plan.skin !== undefined || (record.joints?.length ?? 0) !== 0;
      this.writeMesh(frame, object, plan);
    });
    if (frame.pointRevisions)
      for (const { record, asset } of frame.pointRevisions) {
        const binding = record.binding;
        if (asset.handle === undefined || binding === undefined)
          throw new Error('Point revision lost its submitted geometry binding');
        if (asset.handle === binding.mesh) continue;
        this.write(record.entity, MeshFilter, { assetHandle: asset.handle });
        binding.mesh = asset.handle;
      }
    const cameraEntity = this.nodes.get(frame.camera)?.entity;
    if (cameraEntity === undefined) throw new Error('admitted camera missing its entity');
    const orderOpaqueByLayer = frame.lists.opaqueRanks.size !== 0;
    this.write(
      cameraEntity,
      NativeCamera,
      cameraData.orderOpaqueByLayer === orderOpaqueByLayer
        ? cameraData
        : { ...cameraData, orderOpaqueByLayer },
    );
    if (frame.cameraClipping !== undefined) {
      this.ensure(cameraEntity, ClippingPlanes);
      this.write(cameraEntity, ClippingPlanes, clippingPlanesData(frame.cameraClipping));
    } else this.removeIfPresent(cameraEntity, ClippingPlanes);
    // Skin admission can introduce separate joint entities after source poses are published.
    if (skinPoseUpdated && this.options.propagate !== false)
      propagateTransforms(this.world).unwrap();
    for (const texture of frame.lists.uploadedTextures) this.textureUpdates.add(texture);
  }

  private detachTransformParent(record: PoseRecord): void {
    if (record.parent === undefined) return;
    if (this.world.hasComponent(record.entity, ChildOf))
      this.world.removeComponent(record.entity, ChildOf).unwrap();
    record.parent = undefined;
  }

  private commitTransformParents(frame: ScenePreparation): void {
    // Detach obsolete edges before attaching new ones. A valid source move can
    // reverse an edge or keep a child whose previous parent is about to retire.
    for (const [object, parent] of frame.lists.transformParents) {
      const record = this.nodeRecord(object);
      this.detachTransformParent(record);
      if (parent === null && !frame.lists.transforms.has(object)) {
        record.transform = [];
        record.localVersion = undefined;
      }
    }
    for (const [object, parent] of frame.lists.transformParents) {
      if (parent === null) continue;
      const record = this.nodeRecord(object);
      const target = this.nodeRecord(parent).entity;
      this.world
        .addComponent(record.entity, { component: ChildOf, data: { parent: target } })
        .unwrap();
      record.parent = target;
    }
  }

  private spawnNode(object: Object3D): NodeRecord {
    const entity = this.world
      .spawn({ component: Transform, data: {} }, { component: Name, data: { value: object.name } })
      .unwrap();
    const record: NodeRecord = { entity, transform: [] };
    this.nodes.set(object, record);
    if (this.ecsPoseChanges !== undefined && !separateDrawPose(object))
      this.poseOwners.set(unpackSlot(entity), object);
    this.nativeOwners?.set(unpackSlot(entity), object);
    this.viewOrderOwners?.set(entity, object);
    if (object instanceof InstancedMesh) {
      const invalidate = () => {
        record.instances = [];
      };
      object.addEventListener('dispose', invalidate);
      record.disposeSource = () => object.removeEventListener('dispose', invalidate);
    }
    return record;
  }

  private addRenderableComponents(entity: EntityHandle, object: Renderable): void {
    this.world.addComponent(entity, { component: MeshFilter, data: {} }).unwrap();
    if (object instanceof InstancedMesh)
      this.world.addComponent(entity, { component: Instances, data: {} }).unwrap();
    if (object instanceof Line)
      this.world.addComponent(entity, { component: NativeLines, data: { width: 1 } }).unwrap();
    if (object instanceof Points)
      this.world.addComponent(entity, { component: NativePoints, data: { size: 1 } }).unwrap();
    this.world.addComponent(entity, { component: MeshRenderer, data: {} }).unwrap();
    this.world
      .addComponent(entity, {
        component: ShadowParticipation,
        data: { cast: false, receive: false },
      })
      .unwrap();
  }

  private addLightComponents(entity: EntityHandle, object: Object3D): void {
    if (object instanceof DirectionalLight)
      this.world
        .addComponent(entity, {
          component: NativeDirectionalLight,
          data: { direction: [0, -1, 0], castShadow: false },
        })
        .unwrap();
    if (object instanceof RectAreaLight)
      this.world.addComponent(entity, { component: NativeRectAreaLight, data: {} }).unwrap();
    if (object instanceof PointLight)
      this.world.addComponent(entity, { component: NativePointLight, data: {} }).unwrap();
    if (object instanceof SpotLight)
      this.world
        .addComponent(entity, {
          component: NativeSpotLight,
          data: { direction: [0, -1, 0], castShadow: false },
        })
        .unwrap();
  }

  private writeSceneLighting(
    scene: Object3D,
    lighting: SceneLighting,
    ambientIrradiance: [number, number, number],
  ): void {
    const sceneEntity = this.nodes.get(scene)?.entity;
    if (sceneEntity === undefined) throw new Error('admitted scene missing its entity');
    if (lighting.targetEnvironment !== undefined) {
      this.ensure(sceneEntity, RenderTargetEnvironment);
      this.write(sceneEntity, RenderTargetEnvironment, {
        source: this.world.internSharedRef(
          'RenderTargetEnvironmentSource',
          lighting.targetEnvironment,
        ),
      });
    } else this.removeIfPresent(sceneEntity, RenderTargetEnvironment);
    this.ensure(sceneEntity, Skylight, { intensity: 0 });
    this.write(sceneEntity, Skylight, {
      ambientIrradiance,
      equirect: lighting.lighting,
      intensity:
        (lighting.lighting !== 0 || lighting.targetEnvironment !== undefined) &&
        scene instanceof Scene
          ? scene.environmentIntensity
          : 0,
      rotation: lighting.lightingRotation,
    });
    if (lighting.background !== 0) {
      this.ensure(sceneEntity, SkyboxBackground);
      this.write(sceneEntity, SkyboxBackground, {
        equirect: lighting.background,
        rotation: lighting.backgroundRotation,
      });
    } else this.removeIfPresent(sceneEntity, SkyboxBackground);
    if (lighting.fog !== undefined) {
      this.ensure(sceneEntity, NativeFog);
      this.write(sceneEntity, NativeFog, lighting.fog);
    } else this.removeIfPresent(sceneEntity, NativeFog);
  }

  private commitTransform(record: PoseRecord, transform: SourceTransform): void {
    if ('data' in transform) {
      record.localVersion = undefined;
      this.write(record.entity, Transform, transform.data);
      record.transform = transform.values;
      record.skinWorldRevision = transform.skinWorldRevision;
    } else {
      this.writeLocalTransform(record, transform.pose, 0);
      record.transform = transform.pose;
      record.localVersion = transform.localVersion;
      record.skinWorldRevision = undefined;
    }
  }

  private writeLocalTransform(record: PoseRecord, pose: ArrayLike<number>, offset: number): void {
    const { pos, quat, scale } = this.poseFields;
    for (let i = 0; i < 3; i++) {
      pos[i] = pose[offset + i] as number;
      scale[i] = pose[offset + 7 + i] as number;
    }
    for (let i = 0; i < 4; i++) quat[i] = pose[offset + 3 + i] as number;
    if (this.options.world === undefined)
      this.world.set(record.entity, Transform, this.poseFields).unwrap();
    else this.write(record.entity, Transform, this.poseFields);
  }

  private readonly nodeName = { value: '' };
  private readonly nodeShadow = { channels: 0, cast: false, receive: false };

  private writeNodeState(
    object: Object3D,
    entity: EntityHandle,
    fields: NodeStateFields,
    observed: boolean,
  ): void {
    if (fields & NodeStateFields.Name) {
      const name = this.nodeName;
      name.value = object.name;
      if (observed) this.world.set(entity, Name, name).unwrap();
      else this.write(entity, Name, name);
    }
    if (fields & NodeStateFields.Shadow && isRenderable(object)) {
      const shadow = this.nodeShadow;
      shadow.channels = object.layers.mask >>> 0;
      shadow.cast = object.castShadow;
      shadow.receive = object.receiveShadow;
      if (observed) this.world.set(entity, ShadowParticipation, shadow).unwrap();
      else this.write(entity, ShadowParticipation, shadow);
    }
  }

  private writeNode(frame: ScenePreparation, object: Object3D, record: NodeRecord): void {
    const initializing = !record.renderReady;
    if (initializing) {
      const { entity } = record;
      if (object instanceof Camera)
        this.world.addComponent(entity, { component: NativeCamera, data: {} }).unwrap();
      if (isRenderable(object)) this.addRenderableComponents(entity, object);
      this.addLightComponents(entity, object);
      record.renderReady = true;
    }
    const changes = frame.changes;
    const observed =
      !!changes &&
      this.options.world === undefined &&
      changes.members.has(object) &&
      !changes.unobservedNodeState.has(object);
    if (initializing || !observed) {
      this.writeNodeState(object, record.entity, NodeStateFields.All, false);
      if (changes?.nodeState.size) changes.nodeState.delete(object);
    }
    if (frame.buffers.nativeTransparentOrder)
      record.groupOrder = frame.lists.groupOrders.get(object) ?? 0;
    const cached = isRenderable(object) ? frame.changes?.viewDraws.get(object) : undefined;
    if (cached && isRenderable(object) && frame.reusedDraws.has(object)) {
      const layer = frame.lists.transparentRanks.get(object) ?? 0;
      if (cached?.blended && (!record.binding || record.binding.layer !== layer)) {
        this.write(record.entity, Layer, { value: layer });
        if (record.binding) record.binding.layer = layer;
      }
      return;
    }
    if (!isRenderable(object)) {
      this.writeLight(frame, object, record.entity);
      return;
    }
    if (cached) {
      cached.live = frame.meshes.has(object);
      cached.zoom = frame.camera.projectionMatrix.elements[5];
      cached.perspective = frame.camera.projectionMatrix.elements[11];
      cached.pixelRatio = frame.buffers.pixelRatio ?? 1;
    }
    if (!frame.meshes.has(object)) {
      const hadBinding = record.binding !== undefined;
      record.binding = undefined;
      if (record.meshGeometry?.source !== object.geometry) {
        releaseMeshCache(record);
        record.meshGeometry = undefined;
        record.ordinaryMesh = undefined;
        record.meshMaterials = undefined;
      } else if (!matchesMaterialRoster(frame.scene, object, record.meshMaterials)) {
        releaseMeshCache(record);
        record.meshMaterials = undefined;
        record.ordinaryMesh = undefined;
      }
      if (hadBinding || this.options.world !== undefined) {
        this.write(record.entity, MeshFilter, { assetHandle: 0 as AssetHandle<'mesh'> });
        this.write(record.entity, MeshRenderer, { materials: [] });
      }
    }
  }

  private releaseNode(record: NodeRecord): void {
    releaseMeshCache(record);
    const source = record.sourcePose;
    this.poseOwners.delete(unpackSlot(source?.entity ?? record.entity));
    if (source !== undefined && this.world.componentsOf(source.entity).ok)
      this.world.despawn(source.entity).unwrap();
    this.nativeOwners?.delete(unpackSlot(record.entity));
    this.viewOrderOwners?.delete(record.entity);
    for (const joint of record.joints ?? []) this.nativeOwners?.delete(unpackSlot(joint));
    record.disposeSource?.();
    for (const joint of record.joints ?? [])
      if (this.world.componentsOf(joint).ok) this.world.despawn(joint).unwrap();
    if (this.world.componentsOf(record.entity).ok) this.world.despawn(record.entity).unwrap();
  }

  private writeLight(frame: ScenePreparation, object: Object3D, entity: EntityHandle): void {
    if (!frame.visible.has(object)) {
      this.darkenLight(object, entity);
      return;
    }
    if (object instanceof DirectionalLight || object instanceof SpotLight)
      this.writeAimedLight(frame, object, entity);
    if (object instanceof RectAreaLight)
      this.write(entity, NativeRectAreaLight, {
        color: object.color.toArray(),
        intensity: object.intensity,
        width: object.width,
        height: object.height,
      });
    if (object instanceof PointLight) this.writePointLight(frame, object, entity);
  }

  private darkenLight(object: Object3D, entity: EntityHandle): void {
    if (object instanceof DirectionalLight)
      this.write(entity, NativeDirectionalLight, { intensity: 0 });
    if (object instanceof SpotLight) this.write(entity, NativeSpotLight, { intensity: 0 });
    if (object instanceof PointLight) this.write(entity, NativePointLight, { intensity: 0 });
    if (object instanceof RectAreaLight) this.write(entity, NativeRectAreaLight, { intensity: 0 });
  }

  private writeAimedLight(
    frame: ScenePreparation,
    object: DirectionalLight | SpotLight,
    entity: EntityHandle,
  ): void {
    const direction = this.lightDirection
      .setFromMatrixPosition(object.target.matrixWorld)
      .sub(this.lightOrigin.setFromMatrixPosition(object.matrixWorld))
      .normalize();
    const hasDirection = direction.lengthSq() > 0;
    if (!hasDirection) direction.set(0, -1, 0);
    const light = {
      direction: direction.toArray(),
      color: object.color.toArray(),
      intensity: hasDirection ? object.intensity : 0,
    };
    const shadow = this.projectLightShadow(frame, object) ?? {
      castShadow: false,
    };
    if (object instanceof SpotLight)
      this.write(entity, NativeSpotLight, {
        ...light,
        ...shadow,
        range: object.distance === 0 ? Infinity : object.distance,
        decay: object.decay,
        outerConeDeg: (object.angle * 180) / Math.PI,
        innerConeDeg: (object.angle * (1 - object.penumbra) * 180) / Math.PI,
      });
    else this.write(entity, NativeDirectionalLight, { ...light, ...shadow });
  }

  private writePointLight(frame: ScenePreparation, object: PointLight, entity: EntityHandle): void {
    const shadow = this.projectLightShadow(frame, object);
    if (shadow !== undefined) {
      if (!this.world.hasComponent(entity, NativePointLightShadow))
        this.world
          .addComponent(entity, { component: NativePointLightShadow, data: shadow })
          .unwrap();
      else this.write(entity, NativePointLightShadow, shadow);
    } else this.removeIfPresent(entity, NativePointLightShadow);
    this.write(entity, NativePointLight, {
      color: object.color.toArray(),
      intensity: object.intensity,
      range: object.distance === 0 ? Infinity : object.distance,
      decay: object.decay,
    });
  }

  private projectLightShadow(frame: ScenePreparation, light: ShadowLight) {
    const { changes } = frame;
    if (changes) changes.projectingShadow = light;
    try {
      return this.shadowUpdates.project(light, frame.buffers.shadowMap);
    } finally {
      if (changes) changes.projectingShadow = undefined;
    }
  }

  private updateMeshAdmission(
    frame: ScenePreparation,
    object: Renderable,
    record: NodeRecord,
    plan: MeshPlan,
  ): void {
    const changes = frame.changes;
    if (!changes) return;
    const nativeSkin = frame.ecsPoses && plan.skin?.kind === 'source';
    if (
      !record.meshGeometry ||
      (plan.ordinaryMesh && !record.ordinaryMesh) ||
      (nativeSkin && !record.skinSourceJoints)
    )
      changes.promoteBinding(object);
    if (!plan.ordinaryMesh && !nativeSkin && changes.residents.has(object))
      changes.invalidateBinding(object);
  }

  private writeMesh(frame: ScenePreparation, object: Renderable, plan: MeshPlan): void {
    const handle = plan.asset.handle;
    if (handle === undefined)
      throw new Error('admitted geometry missing its managed asset reference');
    const record = this.nodes.get(object);
    if (record === undefined) throw new Error('admitted mesh missing its entity');
    record.orderedTransparency = plan.blended === true;
    const entity = record.entity;
    const staysOrdinary =
      this.options.world === undefined &&
      record.ordinaryMesh !== undefined &&
      plan.ordinaryMesh !== undefined;
    this.updateMeshAdmission(frame, object, record, plan);
    const previousGeometry = record.meshGeometry;
    record.ordinaryMesh = plan.ordinaryMesh;
    record.meshGeometry = plan.geometry;
    const resident = record.meshMaterials;
    const previous = matchesMaterialRoster(frame.scene, object, resident)
      ? resident.addresses
      : undefined;
    plan.materialPublication ??= meshMaterialPublication(
      plan.materials,
      frame.lists.materialPublications,
    );
    const { handles, addresses } = plan.materialPublication;
    if (previous !== addresses && (previous === undefined || !sameValues(addresses, previous))) {
      const source = object.material;
      record.meshMaterials = {
        source: Array.isArray(source) ? source.slice() : source,
        override: overrideMaterial(frame.scene),
        addresses,
      };
    }
    if (
      record.meshCachePins &&
      (previousGeometry?.source !== plan.geometry.source ||
        previousGeometry.variant !== plan.geometry.variant ||
        resident !== record.meshMaterials)
    )
      this.pinMeshCache(record);
    const before = record.binding;
    const renderLayers = object.layers.mask >>> 0;
    const frustumCulled = object.frustumCulled;
    const layer =
      frame.lists.opaqueRanks.get(object) ?? frame.lists.transparentRanks.get(object) ?? 0;
    if (handle !== before?.mesh) this.write(entity, MeshFilter, { assetHandle: handle });
    if (layer !== before?.layer) {
      this.ensure(entity, Layer);
      this.write(entity, Layer, { value: layer });
    }
    if (
      before === undefined ||
      before.renderLayers !== renderLayers ||
      before.frustumCulled !== frustumCulled ||
      !sameValues(before.materials, handles)
    ) {
      this.write(entity, MeshRenderer, { materials: handles, renderLayers, frustumCulled });
    }
    if (this.options.world === undefined) {
      if (before === undefined)
        record.binding = { mesh: handle, materials: handles, renderLayers, frustumCulled, layer };
      else {
        before.mesh = handle;
        before.materials = handles;
        before.renderLayers = renderLayers;
        before.frustumCulled = frustumCulled;
        before.layer = layer;
      }
    }
    if (staysOrdinary) return;
    if (plan.lineStyle !== undefined) {
      this.ensure(entity, NativeLines, { width: 1 });
      this.write(entity, NativeLines, plan.lineStyle);
    } else if (!(object instanceof Line)) this.removeIfPresent(entity, NativeLines);
    if (plan.pointStyle !== undefined) {
      this.write(entity, NativePoints, plan.pointStyle);
      const draw = frame.changes?.viewDraws.get(object);
      if (draw?.republishPointContent) {
        draw.zoom = frame.camera.projectionMatrix.elements[5];
        draw.perspective = frame.camera.projectionMatrix.elements[11];
        draw.pixelRatio = frame.buffers.pixelRatio ?? 1;
      }
    }
    if (plan.nativeInstances) {
      this.ensure(entity, Instances);
      const planned = plan.instances;
      const change = planned?.kind === 'borrowed' ? planned.write : planned;
      if (change?.kind === 'replace') {
        this.write(entity, Instances, { transforms: change.transforms });
        record.nativeInstanceCount = change.transforms.length / 16;
      } else if (change?.kind === 'patch') {
        for (const { start, values } of change.ranges)
          this.world.setArrayRange(entity, Instances, 'transforms', start, values).unwrap();
      }
    } else this.removeIfPresent(entity, Instances);
    if (plan.instanceValues !== undefined) record.instances = plan.instanceValues;
    this.writeSkin(object, record, plan.skin, !this.options.world || !!frame.changes);
    if (plan.morphWeights !== undefined) {
      this.ensure(entity, MorphWeights);
      this.write(entity, MorphWeights, { weights: plan.morphWeights });
    } else this.removeIfPresent(entity, MorphWeights);
  }

  private writeSkin(
    object: Renderable,
    record: NodeRecord,
    skin: MeshPlan['skin'],
    ownsPose: boolean,
  ): void {
    const entity = record.entity;
    if (skin === undefined) {
      if (!this.world.hasComponent(entity, Skin)) return;
      this.world.removeComponent(entity, Skin).unwrap();
      this.releaseProjectedJoints(record);
      record.skinBinding = undefined;
      record.skinSourceJoints = undefined;
      return;
    }
    if (skin.kind === 'source') this.writeMountedSkin(record, skin);
    else this.writeProjectedSkin(object, record, skin, ownsPose);
  }

  private writeMountedSkin(
    record: NodeRecord,
    skin: Extract<NonNullable<MeshPlan['skin']>, { kind: 'source' }>,
  ): void {
    this.releaseProjectedJoints(record);
    if (
      record.skinSourceJoints !== undefined &&
      sameValues(record.skinSourceJoints, skin.joints) &&
      record.skinBinding === skin.skeleton &&
      record.skinAffinePoint === skin.affinePoint
    )
      return;
    this.ensure(record.entity, Skin);
    this.write(record.entity, Skin, {
      skeleton: skin.skeleton,
      joints: skin.joints,
      affinePoint: skin.affinePoint,
    });
    record.skinBinding = skin.skeleton;
    record.skinSourceJoints = skin.joints;
    record.skinAffinePoint = skin.affinePoint;
  }

  private writeProjectedSkin(
    object: Renderable,
    record: NodeRecord,
    skin: Extract<NonNullable<MeshPlan['skin']>, { kind: 'projected' }>,
    ownsPose: boolean,
  ): void {
    const entity = record.entity;
    record.skinSourceJoints = undefined;
    const joints = record.joints ?? [];
    const sizeChanged = joints.length !== skin.joints.length;
    while (joints.length > skin.joints.length) {
      const joint = joints.pop() as EntityHandle;
      this.nativeOwners?.delete(unpackSlot(joint));
      this.world.despawn(joint).unwrap();
    }
    while (joints.length < skin.joints.length) {
      const joint = this.world.spawn({ component: Transform, data: {} }).unwrap();
      joints.push(joint);
      this.nativeOwners?.set(unpackSlot(joint), object);
    }
    record.joints = joints;
    const previous = ownsPose ? record.jointPoses : undefined;
    const patch = skin.patch;
    if (previous !== skin.joints || record.jointVersion !== patch?.version) {
      const indices =
        previous === skin.joints && patch && record.jointVersion === patch.version - 1
          ? patch.indices
          : joints.keys();
      for (const index of indices) {
        const joint = joints[index],
          data = skin.joints[index];
        if (joint !== undefined && data && (patch || previous?.[index] !== data))
          this.write(joint, Transform, data);
      }
    }
    record.jointVersion = patch?.version;
    record.jointPoses = skin.joints;
    if (
      !ownsPose ||
      sizeChanged ||
      record.skinBinding !== skin.skeleton ||
      record.skinAffinePoint !== skin.affinePoint
    ) {
      this.ensure(entity, Skin);
      this.write(entity, Skin, { skeleton: skin.skeleton, joints, affinePoint: skin.affinePoint });
      record.skinBinding = skin.skeleton;
      record.skinAffinePoint = skin.affinePoint;
    }
  }

  private releaseProjectedJoints(record: NodeRecord): void {
    for (const joint of record.joints ?? []) {
      this.nativeOwners?.delete(unpackSlot(joint));
      this.world.despawn(joint).unwrap();
    }
    record.joints = undefined;
    record.jointPoses = undefined;
    record.jointVersion = undefined;
  }

  private ensure<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
    data: Partial<InputShapeOf<S>> = {},
  ): void {
    if (!this.world.hasComponent(entity, component))
      this.world.addComponent(entity, { component, data }).unwrap();
  }

  private removeIfPresent(entity: EntityHandle, component: Component): void {
    if (this.world.hasComponent(entity, component))
      this.world.removeComponent(entity, component).unwrap();
  }

  /** Compare against World storage; explicit array writes otherwise publish a change every frame. */
  private write<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
    data: Partial<InputShapeOf<S>>,
  ): void {
    const patch = this.world[worldRead].changedFields(entity, component, data);
    if (patch !== undefined) this.world.set(entity, component, patch).unwrap();
  }

  sources(stage: 'poses' | 'admitted' = 'poses'): ThreeSourceIdentity[] {
    const sources: ThreeSourceIdentity[] = [];
    for (const [source, record] of this.nodes) {
      if (stage === 'admitted' && !record.renderReady) continue;
      sources.push({
        uuid: source.uuid,
        name: source.name,
        type: source.type,
        entityKey: record.entity,
      });
    }
    return sources;
  }

  /** Identity lookup never materializes the diagnostic source inventory. */
  entityFor(source: Object3D): EntityHandle | undefined {
    const entity = this.nodes.get(source)?.entity;
    return entity !== undefined && this.world.hasComponent(entity, Transform) ? entity : undefined;
  }

  private validateTransformParent(record: NodeRecord): void {
    if (this.world[worldRead].getFieldValue(record.entity, ChildOf, 'parent') !== record.parent)
      throw new ThreeCompatibilityError(
        'three-interop-invalid',
        'Native parent of a Three-owned entity',
        'Edit the source Object3D hierarchy before synchronizing this mount.',
      );
  }

  private assertRetirableNode(record: NodeRecord): void {
    if (!this.options.world || !this.world.hasComponent(record.entity, Children)) return;
    for (const child of this.world.get(record.entity, Children).unwrap().entities) {
      const source = this.nativeOwners?.get(unpackSlot(child));
      if (source && this.nodes.get(source)?.entity === child) continue;
      throw new ThreeCompatibilityError(
        'three-interop-invalid',
        'Native child of a Three-owned entity',
        'Detach native ChildOf relationships before synchronizing or disposing this mount; native entities must not be cascade-despawned.',
      );
    }
  }

  assertRetirable(): void {
    for (const record of this.nodes.values()) this.assertRetirableNode(record);
  }

  dispose(): void {
    this.assertRetirable();
    setViewDrawOrder(this.world, undefined);
    this.releaseTracking();
    for (const record of this.nodes.values())
      this.detachTransformParent(record.sourcePose ?? record);
    for (const record of this.nodes.values()) this.releaseNode(record);
    this.nodes.clear();
    this.sourcePoses.release(0);
    this.viewOrderOwners = undefined;
    this.viewOrderCamera = undefined;
    this.canvasTextures?.dispose();
    for (const store of this.resourceStores) store.dispose();
  }

  private validateObject(object: Object3D): void {
    if (!Number.isFinite(object.renderOrder)) invalid('Object3D.renderOrder', object.uuid).unwrap();
    if (
      ![
        'Scene',
        'Object3D',
        'AnimationPathHelper',
        'Group',
        'BundleGroup',
        'LOD',
        'Mesh',
        'MorphAnimMesh',
        'InstancedMesh',
        'BatchedMesh',
        'SkinnedMesh',
        'Bone',
        'Line',
        'LineSegments',
        'Points',
        'Sprite',
        'CubeCamera',
        'PerspectiveCamera',
        'OrthographicCamera',
        'AmbientLight',
        'DirectionalLight',
        'PointLight',
        'RectAreaLight',
        'SpotLight',
      ].includes(object.type)
    )
      unsupported(object.type, object.uuid).unwrap();
    if (
      isRenderable(object) &&
      (object.onBeforeRender !==
        (object instanceof BatchedMesh
          ? BatchedMesh.prototype.onBeforeRender
          : Object3D.prototype.onBeforeRender) ||
        object.onAfterRender !== Object3D.prototype.onAfterRender)
    )
      unsupported('Object3D renderOrder/shadows/render callbacks', object.uuid).unwrap();
    if (
      object instanceof RectAreaLight ||
      object instanceof AmbientLight ||
      object instanceof DirectionalLight ||
      object instanceof PointLight ||
      object instanceof SpotLight
    ) {
      validateLight(object);
    }
  }
}

function watchDrawMaterials(
  changes: SceneChanges,
  node: Renderable,
  plan: MeshPlan,
  native: boolean,
  nativeSkin: boolean,
): boolean {
  for (const use of plan.materials) {
    const direct =
      !native &&
      (use.effective === use.source || hasSurfaceBinding(use.source)) &&
      !use.skinProgram &&
      ((Object.getPrototypeOf(node) === Mesh.prototype && !Array.isArray(node.material)) ||
        (node instanceof Sprite && plan.uv?.values.length === 0) ||
        (use.coordinates.size === 0 && useTextures(use).length === 0));
    if (
      !changes.watchUse(
        node,
        use.source,
        use.variant,
        use.shading,
        !native,
        direct,
        direct || nativeSkin ? use.coordinates : undefined,
        use.skinProgram,
      )
    )
      return false;
  }
  return true;
}

function releaseMeshCache(record: NodeRecord): void {
  if (record.meshCachePins === undefined) return;
  for (const release of record.meshCachePins) release();
  record.meshCachePins = undefined;
}
