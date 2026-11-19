import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import {
  type Component,
  type ComponentSchema,
  type EntityHandle,
  type InputShapeOf,
  World,
} from '@forgeax/engine-ecs';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import {
  type CameraData,
  ClippingPlanes,
  clippingPlanesData,
  FogModeValue,
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
  PointSizeUnitsValue,
  RenderTargetEnvironment,
  type RenderTargetEnvironmentSource,
  ShadowParticipation,
  SkyboxBackground,
  Skylight,
} from '@forgeax/engine-render';
import {
  Children,
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
  type MeshAsset,
  ok,
  type ResolvedMaterialTextureCoordinates,
  type SamplerAsset,
  type SkeletonAsset,
  type TextureAsset,
  withClipping,
} from '@forgeax/engine-types';
import IESSpotLight from 'three/src/lights/webgpu/IESSpotLight.js';
import ProjectorLight from 'three/src/lights/webgpu/ProjectorLight.js';
import type { RenderItem } from 'three/src/renderers/common/Renderer.js';
import {
  AmbientLight,
  BatchedMesh,
  type BufferGeometry,
  Camera,
  Color,
  DirectionalLight,
  Fog,
  FogExp2,
  Frustum,
  Group,
  InstancedMesh,
  Line,
  LineSegments,
  LOD,
  type Material,
  Matrix4,
  Mesh,
  Object3D,
  PointLight,
  Points,
  PointsMaterial,
  Quaternion,
  RectAreaLight,
  RedFormat,
  Scene,
  type Skeleton,
  SkinnedMesh,
  SpotLight,
  Sprite,
  type Texture,
  Vector3,
  Vector4,
  VSMShadowMap,
} from 'three/src/Three.Core.js';
import { objectClipping, projectClipping, type SourceClipping } from './clipping';
import { projectEnvironment, scaleEnvironment } from './environment';
import { invalid, ThreeCompatibilityError, unsupported } from './errors';
import { type ExternalTextures, isExternalTexture } from './external-textures';
import { projectFlatNormals } from './flat-normals';
import { type GeometryMaterial, geometryValues, projectGeometry } from './geometry';
import { instanceGeometryValues, projectInstanceGeometry } from './instance-geometry';
import { lineStyle } from './lines';
import {
  materialTextures,
  materialValues,
  projectMaterial,
  type SupportedMaterial,
  usesFlatShading,
  validateMaterial,
} from './material';
import {
  isBasicMaterial,
  isLineMaterial,
  isMatcapMaterial,
  isNormalMaterial,
  isPointsMaterial,
  isSpriteMaterial,
} from './material-kinds';
import { admitSurfaceInput, surfaceInput, usesTransmission } from './node-inputs';
import { threeSurfaceUvSets, validateThreeSurfaceGeometry } from './node-surface';
import type { RenderTargets } from './render-targets';
import { expandScalarTexture } from './scalar-texture';
import { type ShadowMapSettings, ShadowUpdates } from './shadow';
import { SharedAssets, sameValues } from './shared-assets';
import {
  cpuSkinValues,
  projectCpuSkin,
  projectJoints,
  projectSkeleton,
  skinValues,
} from './skinning';
import { spriteMatrix } from './sprite';
import {
  projectSampler,
  projectTextureUpload,
  samplerValues,
  textureCoordinates,
  textureUploadPending,
  textureValues,
  validateTexture,
} from './texture';
import { projectUvs, type UvProjection } from './uv-projection';

interface NodeRecord {
  readonly entity: EntityHandle;
  transform: readonly number[];
  instances?: readonly unknown[];
  disposeSource?: () => void;
  joints?: EntityHandle[];
}
type Renderable = Mesh | Line | Points | Sprite;
function isRenderable(object: Object3D): object is Renderable {
  return (
    object instanceof Mesh ||
    object instanceof Line ||
    object instanceof Points ||
    object instanceof Sprite
  );
}

interface MaterialUse {
  readonly source: Material;
  readonly effective: SupportedMaterial;
  variant: string;
  queue?: number;
  readonly clipping?: ClippingOptions;
  readonly shading: 0 | 1;
  readonly skinned: boolean;
  readonly shadowOnly: boolean;
  readonly coordinates: Map<Texture, ResolvedMaterialTextureCoordinates>;
}
interface MeshPlan {
  readonly source: Renderable;
  readonly variant: string;
  readonly materials: readonly MaterialUse[];
  readonly values: unknown[];
  readonly payload: MeshAsset;
  readonly instanceValues: readonly unknown[] | undefined;
  readonly instances: Float32Array | undefined;
  readonly nativeInstances: boolean;
  readonly morphWeights: Float32Array | undefined;
  readonly pointStyle: ReturnType<typeof pointStyle> | undefined;
  readonly lineStyle: NonNullable<ReturnType<typeof lineStyle>> | undefined;
  readonly skin:
    | { skeleton: AssetHandle<'skeleton'>; joints: ReturnType<typeof projectJoints> }
    | undefined;
}
interface TexturePlan {
  readonly orientation: 0 | 1;
  readonly variant: '' | 'scalar-color' | 'scalar-data';
  readonly source: Texture;
  readonly values: unknown[];
  readonly payload: TextureAsset;
  readonly sampler: SamplerAsset;
  readonly samplerValues: unknown[];
}
export interface ThreeSourceIdentity {
  readonly uuid: string;
  readonly name: string;
  readonly type: string;
  readonly entityKey: number;
}

interface SceneBuffers {
  pixelRatio?: number;
  /** Keep leases observed by preceding offscreen passes in this composition. */
  deferResourceSweep?: boolean;
  depth: boolean;
  stencil: boolean;
  sortObjects: boolean;
  transparentSort?: ((a: RenderItem, b: RenderItem) => number) | null;
  opaqueOrder?: boolean;
  opaqueSort?: ((a: RenderItem, b: RenderItem) => number) | null;
  opaque: boolean;
  transparent: boolean;
  updateMatrices: boolean;
  shadowMap?: ShadowMapSettings;
}

interface SceneProjectionOptions {
  readonly targets?: RenderTargets;
  readonly world?: World;
  readonly validateSource?: (object: Object3D, entity: EntityHandle | undefined) => void;
  /** A mixed host owns its existing Scene/Physics propagation schedule. */
  readonly propagate?: boolean;
}

/** Cached source world matrices author flat native affine transforms; Scene derives the GPU-facing matrices. */
export class SceneProjection {
  constructor(
    assets: AssetRegistry,
    private readonly external?: ExternalTextures,
    private readonly prepareMaterialPrograms?: (
      material: MaterialAsset,
      skinned?: boolean,
    ) => MaterialAsset,
    private readonly options: SceneProjectionOptions = {},
  ) {
    this.world = options.world ?? new World({ assets });
    this.geometry = new SharedAssets(assets);
    this.materials = [new SharedAssets(assets), new SharedAssets(assets)];
    this.textures = [new SharedAssets(assets), new SharedAssets(assets)];
    this.samplers = new SharedAssets(assets);
    this.environments = new SharedAssets(assets);
    this.skeletons = new SharedAssets(assets);
  }

  readonly world: World;
  readonly shadowUpdates = new ShadowUpdates();
  private readonly textureUpdates = new Set<Texture>();

  submitted(): void {
    this.shadowUpdates.submitted();
    const updates = [...this.textureUpdates];
    this.textureUpdates.clear();
    for (const texture of updates) texture.onUpdate?.(texture);
  }

  private readonly nodes = new Map<Object3D, NodeRecord>();
  private readonly geometry: SharedAssets<BufferGeometry, MeshAsset>;
  // Geometry can require flat shading while another mesh shares this source material.
  private readonly materials: readonly [
    SharedAssets<Material, MaterialAsset>,
    SharedAssets<Material, MaterialAsset>,
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
    const caches = [
      this.geometry,
      ...this.materials,
      ...this.textures,
      this.samplers,
      this.environments,
      this.skeletons,
    ];
    for (const cache of caches) cache.begin();
    try {
      const commitScene = runtimeAssets(this.world.assets)
        .adoptClosure(() => ok(this.prepare(scene, camera, cameraData, buffers)))
        .unwrap();
      for (const cache of caches) cache.commit(!buffers.deferResourceSweep);
      return commitScene();
    } catch (error) {
      for (const cache of caches) cache.abort();
      throw error;
    }
  }

  private prepare(
    scene: Object3D,
    camera: Camera,
    cameraData: CameraData,
    buffers: SceneBuffers,
  ): () => EntityHandle {
    if (this.options.validateSource !== undefined) {
      for (const [object, record] of this.nodes) {
        this.assertRetirableNode(record);
        this.options.validateSource(object, record.entity);
      }
      if (!this.nodes.has(camera)) this.options.validateSource(camera, undefined);
    }
    this.shadowUpdates.begin();
    const uploadedTextures = new Set<Texture>();
    const lighting = this.prepareSceneLighting(scene, uploadedTextures);
    const frame = createScenePreparation(scene, camera, buffers, uploadedTextures);
    updateSourceMatrices(scene, camera, buffers);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem,
      camera.reversedDepth,
    );
    this.walkScene(frame);
    const { camera: cameraClipping, local: localClipping } = projectClipping(
      clippingCandidates(frame.visible),
      frame.clipping,
    );
    frame.cameraClipping = cameraClipping;
    this.projectTransforms(frame);
    for (const object of frame.nodes) {
      if (frame.visible.has(object) && isRenderable(object))
        this.planMesh(frame, object, frustum, localClipping.get(object));
    }
    const ambientIrradiance = sceneAmbientIrradiance(scene, frame.visible);
    // New resource leases stay provisional until all material preparation succeeds.
    rankOpaqueMeshes(frame);
    this.publishMaterials(frame, this.publishTextures(frame));
    this.publishGeometry(frame);
    rankTransparentMeshes(frame);
    return () => this.commit(frame, lighting, ambientIrradiance, cameraData);
  }

  /** Scene-owned image lighting and backdrop; validates the Scene-level Three features first. */
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

  private walkScene(frame: ScenePreparation): void {
    this.visit(frame, frame.scene, true, undefined, 0);
    for (const object of frame.visible) frame.displayVisible.add(object);
    if (frame.buffers.shadowMap?.enabled) this.admitShadowCasters(frame);
    // Scene owns ambient state even when its own layer does not match the camera.
    frame.nodes.add(frame.scene);
    this.validateObject(frame.camera);
    frame.nodes.add(frame.camera);
  }

  private visit(
    frame: ScenePreparation,
    object: Object3D,
    parentVisible: boolean,
    parentClipping: SourceClipping | undefined,
    groupOrder: number,
  ): void {
    if (!this.nodes.has(object)) this.options.validateSource?.(object, undefined);
    frame.nodes.add(object);
    const active = parentVisible && object.visible;
    if (active) frame.active.add(object);
    const matched = active && object.layers.test(frame.camera.layers);
    const planes = matched ? objectClipping(object, parentClipping) : parentClipping;
    const order = matched && object instanceof Group ? object.renderOrder : groupOrder;
    frame.groupOrders.set(object, order);
    frame.clipping.set(object, planes);
    if (matched) {
      if (object instanceof LOD && object.autoUpdate) object.update(frame.camera);
      this.validateObject(object);
      frame.visible.add(object);
    }
    for (const child of object.children) this.visit(frame, child, active, planes, order);
  }

  /** Active renderables outside the camera layers still draw into a matching light's shadow map. */
  private admitShadowCasters(frame: ScenePreparation): void {
    const shadowMasks = shadowCameraMasks(frame.visible, frame.camera);
    for (const object of frame.active) {
      if (
        !isRenderable(object) ||
        !castsShadow(object, frame.varianceShadow) ||
        !shadowMasks.some((mask) => (object.layers.mask & mask) !== 0)
      )
        continue;
      this.validateObject(object);
      frame.visible.add(object);
    }
  }

  private projectTransforms(frame: ScenePreparation): void {
    const camera = frame.camera;
    for (const object of frame.nodes) {
      if (object !== camera && !frame.visible.has(object)) continue;
      const values = sourceMatrix(object, camera, frame.scene);
      if (sameValues(this.nodes.get(object)?.transform ?? [], values)) continue;
      frame.transforms.set(object, {
        values: [...values],
        data: decomposeSourceMatrix(object, camera, values),
      });
    }
  }

  private planMesh(
    frame: ScenePreparation,
    object: Renderable,
    frustum: Frustum,
    planes: ClippingOptions | undefined,
  ): void {
    if (isCulled(frame, object, frustum)) return;
    const selection: GeometryMaterial[] = [];
    const list: MaterialUse[] = [];
    const coordinates = new Map<Texture, ResolvedMaterialTextureCoordinates>();
    selectMaterials(frame, object, planes, coordinates, selection, list);
    if (list.length === 0) return;
    const cpuSkin = object instanceof SkinnedMesh && list.some((use) => !use.skinned);
    if (cpuSkin) for (const use of list) Object.assign(use, { skinned: false });
    const wireframe = isWireframe(object, list);
    rejectOrderedOpaque(frame, object, list);
    for (const use of list) validateThreeSurfaceGeometry(use.effective, object.geometry);
    const uv = projectUvs(
      object.geometry,
      object instanceof Points ? [] : uvTextures(list),
      list.flatMap((use) => [...threeSurfaceUvSets(use.effective)]),
    );
    for (const [texture, value] of uv.coordinates) coordinates.set(texture, value);
    const shape: GeometryShape = {
      topology: wireframe ? 'line-list' : sourceTopology(object),
      grouped: Array.isArray(object.material),
      selection,
      wireframe,
      uv,
      flatMatcap: flatMatcapSlots(list),
      expanded: expandsInstances(object),
      cpuSkin,
      morphColor: projectsMorphColor(object.geometry, selection),
    };
    const variant = geometryVariant(object, shape);
    const values = geometryCacheValues(object, shape, frame.camera, list[0]?.effective);
    const payload = this.readMeshGeometry(object, shape, values, variant);
    if (payload === undefined) return;
    for (const use of list) this.admitMaterialUse(frame, object, use);
    const lines = meshLineStyle(object, payload, list, wireframe);
    if (lines === null) return;
    const instanceValues =
      object instanceof InstancedMesh ? instanceSourceValues(object, shape.expanded) : undefined;
    const instances = this.nativeInstanceTransforms(object, instanceValues, shape.expanded);
    if (object instanceof InstancedMesh && object.count === 0) return;
    const skin =
      object instanceof SkinnedMesh && !cpuSkin ? this.planSkin(object, payload) : undefined;
    const morphWeights = meshMorphWeights(object, payload);
    frame.meshes.set(object, {
      source: object,
      variant,
      materials: list,
      values,
      payload,
      nativeInstances: object instanceof InstancedMesh && !shape.expanded,
      instanceValues,
      instances,
      morphWeights,
      skin,
      lineStyle: lines,
      pointStyle: object instanceof Points ? pointStyle(object, frame, list) : undefined,
    });
  }

  private readMeshGeometry(
    object: Renderable,
    shape: GeometryShape,
    values: ReturnType<typeof geometryCacheValues>,
    variant: string,
  ): MeshAsset | undefined {
    return (
      this.geometry.read(object.geometry, values, variant)?.payload ??
      projectMeshGeometry(object, shape)
    );
  }

  /** Source matrices change only with their version; undefined keeps the published transforms. */
  private nativeInstanceTransforms(
    object: Renderable,
    instanceValues: readonly unknown[] | undefined,
    expanded: boolean,
  ): Float32Array | undefined {
    if (!(object instanceof InstancedMesh) || instanceValues === undefined || expanded)
      return undefined;
    if (sameValues(this.nodes.get(object)?.instances ?? [], instanceValues)) return undefined;
    const instances = new Float32Array(object.instanceMatrix.array.slice(0, object.count * 16));
    for (let offset = 0; offset < instances.length; offset += 16) {
      const matrix = instances.subarray(offset, offset + 16);
      if (!mat4.decomposeAffine(vec3.create(), quat.create(), vec3.create(), vec3.create(), matrix))
        invalid('InstancedMesh.instanceMatrix', object.uuid).unwrap();
    }
    return instances;
  }

  private planSkin(object: SkinnedMesh, payload: MeshAsset): NonNullable<MeshPlan['skin']> {
    const values = skinValues(object),
      variant = JSON.stringify(object.bindMatrix.elements);
    const skeleton =
      this.skeletons.read(object.skeleton, values, variant) ??
      this.skeletons.write(object.skeleton, values, projectSkeleton(object), variant);
    if (payload.attributes.skinIndex === undefined || payload.attributes.skinWeight === undefined)
      invalid('SkinnedMesh skinIndex/skinWeight', object.uuid).unwrap();
    if (
      payload.attributes.skinIndex instanceof Uint16Array &&
      payload.attributes.skinIndex.some((joint) => joint >= object.skeleton.bones.length)
    )
      invalid('SkinnedMesh joint index', object.uuid).unwrap();
    return { skeleton: skeleton.handle, joints: projectJoints(object) };
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
    if (frame.clipping.get(object) !== undefined && source.alphaToCoverage)
      unsupported(
        'ClippingGroup alphaToCoverage requires native smooth clipping coverage',
        object.uuid,
      ).unwrap();
    if (object instanceof Line || object instanceof Points)
      projectLinePointMaterial(object, source, use.coordinates);
    if (isNormalMaterial(source) && !object.geometry.hasAttribute('normal'))
      unsupported('Normal/Matcap without normals requires flat shading', object.uuid).unwrap();
    frame.usedMaterials[use.shading].add(use);
    for (const [parameter, texture] of materialTextures(source)) {
      const projection = textureProjection(source, parameter, texture);
      if (isExternalTexture(texture) || texture.isRenderTargetTexture) continue;
      let plans = frame.texturePlans[projection];
      if (plans === undefined) {
        plans = new Map();
        frame.texturePlans[projection] = plans;
      }
      if (!plans.has(texture)) plans.set(texture, this.planTexture(texture, projection));
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
          const previous = cache.read(texture, plan.values);
          const entry = previous ?? cache.write(texture, plan.values, plan.payload);
          cache.retain(texture);
          return ok({
            handle: entry.handle,
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

  private planTexture(texture: Texture, projection: TextureProjection): TexturePlan {
    const orientation = projection === 1 || projection === 3 ? 1 : 0;
    const variant = projection < 2 ? '' : projection === 4 ? 'scalar-data' : 'scalar-color';
    validateTexture(texture).unwrap();
    if (
      orientation === 1 &&
      texture.matrix.elements.some((value, index) => value !== (index % 4 === 0 ? 1 : 0))
    )
      unsupported('Matcap Texture UV transform', texture.uuid).unwrap();
    const values = textureValues(texture),
      samplerSignature = samplerValues(texture);
    const previous = this.textures[orientation].read(texture, values, variant);
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
      payload:
        previous?.payload ??
        (variant === '' ? raw : expandScalarTexture(raw, variant === 'scalar-color')),
      sampler:
        this.samplers.read(texture, samplerSignature)?.payload ?? projectSampler(texture).unwrap(),
    };
  }

  private publishTextures(frame: ScenePreparation): TextureBindings {
    const textureBindings: TextureBindings = [
      new Map(),
      new Map(),
      undefined,
      undefined,
      undefined,
    ];
    for (let projection = 0; projection < frame.texturePlans.length; projection++) {
      const plans = frame.texturePlans[projection];
      if (plans === undefined) continue;
      let bindings = textureBindings[projection];
      if (bindings === undefined) {
        bindings = new Map();
        textureBindings[projection] = bindings;
      }
      for (const plan of plans.values()) {
        const cache = this.textures[plan.orientation];
        const previous = cache.read(plan.source, plan.values, plan.variant);
        const texture =
          previous ?? cache.write(plan.source, plan.values, plan.payload, plan.variant);
        if (previous === undefined) recordUpload(frame.uploadedTextures, plan.source);
        const sampler =
          this.samplers.read(plan.source, plan.samplerValues) ??
          this.samplers.write(plan.source, plan.samplerValues, plan.sampler);
        bindings.set(plan.source, {
          texture: texture.handle,
          sampler: sampler.handle,
        });
      }
    }
    return textureBindings;
  }

  private publishMaterials(frame: ScenePreparation, textureBindings: TextureBindings): void {
    for (const shading of [0, 1] as const) {
      for (const use of frame.usedMaterials[shading]) {
        const source = use.effective;
        const bindings: Record<string, MaterialTextureValue> = {};
        const values = [...materialValues(source), frame.varianceShadow, use.queue];
        for (const [parameter, texture] of materialTextures(source)) {
          const binding = this.textureBinding(use, parameter, texture, textureBindings);
          const coordinates = use.coordinates.get(texture);
          bindings[parameter] = {
            ...binding,
            ...(coordinates === undefined ? {} : { coordinates }),
          };
          values.push(parameter, ...bindingValues(binding, coordinates));
        }
        const entry =
          this.materials[shading].read(use.source, values, use.variant) ??
          this.materials[shading].write(
            use.source,
            values,
            this.projectMaterialUse(use, bindings, shading, frame.varianceShadow),
            use.variant,
          );
        frame.materialHandles[shading].set(use, entry.handle);
      }
    }
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
    varianceShadow: boolean,
  ): MaterialAsset {
    const source = use.effective;
    let projected = projectMaterial(source, bindings, shading === 1, varianceShadow).unwrap();
    if (use.clipping !== undefined) projected = withClipping(projected, use.clipping);
    if (use.shadowOnly) {
      const [first, ...rest] =
        projected.passes?.filter((pass) => pass.name === 'shadow-caster') ?? [];
      if (projected.parent !== undefined || first === undefined)
        return unsupported('Material has no shadow caster pass', source.uuid).unwrap();
      projected = { ...projected, passes: [first, ...rest] };
    }
    if (use.queue !== undefined) projected = withOpaqueQueue(projected, use.queue);
    if (this.prepareMaterialPrograms !== undefined)
      projected = this.prepareMaterialPrograms(projected, use.skinned);
    return projected;
  }

  private publishGeometry(frame: ScenePreparation): void {
    for (const plan of frame.meshes.values()) {
      const cache = this.geometry;
      const entry =
        cache.read(plan.source.geometry, plan.values, plan.variant) ??
        cache.write(plan.source.geometry, plan.values, plan.payload, plan.variant);
      frame.geometryHandles.set(plan.source, entry.handle);
    }
  }

  private commit(
    frame: ScenePreparation,
    lighting: SceneLighting,
    ambientIrradiance: [number, number, number],
    cameraData: CameraData,
  ): EntityHandle {
    for (const object of frame.nodes) if (!this.nodes.has(object)) this.spawnNode(object);
    this.writeSceneLighting(frame.scene, lighting, ambientIrradiance);
    for (const [object, record] of this.nodes) this.writeNode(frame, object, record);
    for (const [object, record] of this.nodes) this.writeLight(frame, object, record.entity);
    for (const plan of frame.meshes.values()) this.writeMesh(frame, plan);
    const cameraEntity = this.nodes.get(frame.camera)?.entity;
    if (cameraEntity === undefined) throw new Error('admitted camera missing its entity');
    this.write(cameraEntity, NativeCamera, cameraData);
    if (frame.cameraClipping !== undefined) {
      this.ensure(cameraEntity, ClippingPlanes);
      this.write(cameraEntity, ClippingPlanes, clippingPlanesData(frame.cameraClipping));
    } else this.removeIfPresent(cameraEntity, ClippingPlanes);
    if (this.options.propagate !== false) propagateTransforms(this.world).unwrap();
    for (const texture of frame.uploadedTextures) this.textureUpdates.add(texture);
    return cameraEntity;
  }

  private spawnNode(object: Object3D): void {
    const entity = this.world
      .spawn({ component: Transform, data: {} }, { component: Name, data: { value: object.name } })
      .unwrap();
    const record: NodeRecord = { entity, transform: [] };
    this.nodes.set(object, record);
    if (object instanceof InstancedMesh) {
      const invalidate = () => {
        record.instances = [];
      };
      object.addEventListener('dispose', invalidate);
      record.disposeSource = () => object.removeEventListener('dispose', invalidate);
    }
    if (object instanceof Camera)
      this.world.addComponent(entity, { component: NativeCamera, data: {} }).unwrap();
    if (isRenderable(object)) this.addRenderableComponents(entity, object);
    this.addLightComponents(entity, object);
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

  /** Retire a node the source no longer reaches, or refresh its transform, name and shadow roles. */
  private writeNode(frame: ScenePreparation, object: Object3D, record: NodeRecord): void {
    if (!frame.nodes.has(object)) {
      this.releaseNode(record);
      this.nodes.delete(object);
      return;
    }
    const transform = frame.transforms.get(object);
    if (transform !== undefined) {
      this.write(record.entity, Transform, transform.data);
      record.transform = transform.values;
    }
    this.write(record.entity, Name, { value: object.name });
    if (!isRenderable(object)) return;
    this.write(record.entity, ShadowParticipation, {
      channels: object.layers.mask >>> 0,
      cast: castsShadow(object, frame.varianceShadow),
      receive: object.receiveShadow,
    });
    if (!frame.meshes.has(object)) {
      this.write(record.entity, MeshFilter, { assetHandle: 0 as AssetHandle<'mesh'> });
      this.write(record.entity, MeshRenderer, { materials: [] });
    }
  }

  private releaseNode(record: NodeRecord): void {
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
    const direction = new Vector3()
      .setFromMatrixPosition(object.target.matrixWorld)
      .sub(new Vector3().setFromMatrixPosition(object.matrixWorld))
      .normalize();
    const hasDirection = direction.lengthSq() > 0;
    if (!hasDirection) direction.set(0, -1, 0);
    const light = {
      direction: direction.toArray(),
      color: object.color.toArray(),
      intensity: hasDirection ? object.intensity : 0,
    };
    const shadow = this.shadowUpdates.project(object, frame.buffers.shadowMap) ?? {
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
    const shadow = this.shadowUpdates.project(object, frame.buffers.shadowMap);
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

  private writeMesh(frame: ScenePreparation, plan: MeshPlan): void {
    const handle = frame.geometryHandles.get(plan.source);
    if (handle === undefined)
      throw new Error('admitted geometry missing its managed asset reference');
    const record = this.nodes.get(plan.source);
    if (record === undefined) throw new Error('admitted mesh missing its entity');
    const entity = record.entity;
    this.write(entity, MeshFilter, { assetHandle: handle });
    this.ensure(entity, Layer);
    this.write(entity, Layer, { value: frame.transparentRanks.get(plan.source) ?? 0 });
    if (plan.lineStyle !== undefined) {
      this.ensure(entity, NativeLines, { width: 1 });
      this.write(entity, NativeLines, plan.lineStyle);
    } else if (!(plan.source instanceof Line)) this.removeIfPresent(entity, NativeLines);
    if (plan.pointStyle !== undefined) this.write(entity, NativePoints, plan.pointStyle);
    if (plan.nativeInstances) {
      this.ensure(entity, Instances);
      if (plan.instances !== undefined)
        this.write(entity, Instances, { transforms: plan.instances });
    } else this.removeIfPresent(entity, Instances);
    if (plan.instanceValues !== undefined) record.instances = plan.instanceValues;
    this.writeSkin(record, plan.skin);
    if (plan.morphWeights !== undefined) {
      this.ensure(entity, MorphWeights);
      this.write(entity, MorphWeights, { weights: plan.morphWeights });
    } else this.removeIfPresent(entity, MorphWeights);
    this.write(entity, MeshRenderer, {
      materials: plan.materials.map((use) => {
        const handle = frame.materialHandles[use.shading].get(use);
        if (handle === undefined)
          throw new Error('admitted material missing its managed asset reference');
        return handle;
      }),
    });
  }

  private writeSkin(record: NodeRecord, skin: MeshPlan['skin']): void {
    const entity = record.entity;
    if (skin === undefined) {
      if (!this.world.hasComponent(entity, Skin)) return;
      this.world.removeComponent(entity, Skin).unwrap();
      for (const joint of record.joints ?? []) this.world.despawn(joint).unwrap();
      record.joints = [];
      return;
    }
    const joints = record.joints ?? [];
    while (joints.length > skin.joints.length)
      this.world.despawn(joints.pop() as EntityHandle).unwrap();
    while (joints.length < skin.joints.length)
      joints.push(this.world.spawn({ component: Transform, data: {} }).unwrap());
    record.joints = joints;
    for (let index = 0; index < joints.length; index++) {
      const joint = joints[index],
        data = skin.joints[index];
      if (joint !== undefined && data !== undefined) this.write(joint, Transform, data);
    }
    this.ensure(entity, Skin);
    this.write(entity, Skin, { skeleton: skin.skeleton, joints });
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
    const current: Record<string, unknown> = this.world.get(entity, component).unwrap();
    for (const name in data) {
      if (!Object.hasOwn(data, name)) continue;
      const value = data[name];
      const type = component.fields[name]?.type;
      const f32 = type === 'f32' || type?.startsWith('array<f32') === true;
      let changed = false;
      if (Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))) {
        const source = value as ArrayLike<number>;
        const stored = current[name] as ArrayLike<number>;
        changed = stored.length !== source.length;
        for (let i = 0; !changed && i < source.length; i++)
          changed = !Object.is(stored[i], f32 ? Math.fround(source[i] as number) : source[i]);
      } else
        changed = !Object.is(
          current[name],
          f32 && typeof value === 'number' ? Math.fround(value) : value,
        );
      if (changed) {
        this.world.set(entity, component, data).unwrap();
        return;
      }
    }
  }

  sources(): ThreeSourceIdentity[] {
    return [...this.nodes].map(([source, record]) => ({
      uuid: source.uuid,
      name: source.name,
      type: source.type,
      entityKey: record.entity,
    }));
  }

  /** Identity lookup never materializes the diagnostic source inventory. */
  entityFor(source: Object3D): EntityHandle | undefined {
    const entity = this.nodes.get(source)?.entity;
    return entity !== undefined && this.world.hasComponent(entity, Transform) ? entity : undefined;
  }

  private assertRetirableNode(record: NodeRecord): void {
    if (
      this.options.world !== undefined &&
      this.world.hasComponent(record.entity, Children) &&
      this.world.get(record.entity, Children).unwrap().entities.length > 0
    )
      throw new ThreeCompatibilityError(
        'three-interop-invalid',
        'Native child of a Three-owned entity',
        'Detach native ChildOf relationships before synchronizing or disposing this mount; native entities must not be cascade-despawned.',
      );
  }

  assertRetirable(): void {
    for (const record of this.nodes.values()) this.assertRetirableNode(record);
  }

  dispose(): void {
    this.assertRetirable();
    for (const record of this.nodes.values()) this.releaseNode(record);
    this.nodes.clear();
    for (const cache of [
      this.geometry,
      ...this.materials,
      ...this.textures,
      this.samplers,
      this.environments,
      this.skeletons,
    ])
      cache.dispose();
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

function validateLight(
  object: RectAreaLight | AmbientLight | DirectionalLight | PointLight | SpotLight,
): void {
  if (
    ![...object.color.toArray(), object.intensity].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  )
    invalid('Light color/intensity', object.uuid).unwrap();
  if (
    object instanceof RectAreaLight &&
    ![object.width, object.height].every((value) => Number.isFinite(value) && value > 0)
  )
    invalid('RectAreaLight width/height', object.uuid).unwrap();
  if (
    (object instanceof PointLight || object instanceof SpotLight) &&
    (!Number.isFinite(object.distance) ||
      object.distance < 0 ||
      !Number.isFinite(Math.fround(object.decay)) ||
      object.decay < 0)
  )
    invalid('Light distance/decay', object.uuid).unwrap();
  if (object instanceof SpotLight) validateSpotLight(object);
}

function validateSpotLight(object: SpotLight): void {
  if (
    !Number.isFinite(object.angle) ||
    object.angle <= 0 ||
    object.angle > Math.PI / 2 ||
    !Number.isFinite(object.penumbra) ||
    object.penumbra < 0 ||
    object.penumbra > 1
  )
    invalid('SpotLight angle/penumbra', object.uuid).unwrap();
  if (object instanceof IESSpotLight && object.iesMap !== null)
    unsupported(
      'IESSpotLight.iesMap requires a native photometry conversion',
      object.uuid,
    ).unwrap();
  if (object instanceof ProjectorLight)
    unsupported('ProjectorLight requires native rectangular attenuation', object.uuid).unwrap();
  if (object.map !== null)
    unsupported('SpotLight map requires native projector texture projection', object.uuid).unwrap();
}

const NO_EQUIRECT = 0 as AssetHandle<'equirect'>;

interface SceneLighting {
  readonly targetEnvironment?: RenderTargetEnvironmentSource;
  readonly lighting: AssetHandle<'equirect'>;
  readonly background: AssetHandle<'equirect'>;
  readonly lightingRotation: number[];
  readonly backgroundRotation: number[];
  readonly fog?: ReturnType<typeof projectFog>;
}

function projectFog(scene: Scene) {
  const fog = scene.fog;
  if (fog === null) return undefined;
  if (!(fog instanceof Fog || fog instanceof FogExp2))
    return unsupported('Scene.fog type', scene.uuid).unwrap();
  const color = fog.color.toArray();
  if (!color.every((value) => Number.isFinite(Math.fround(value)) && value >= 0))
    invalid('Scene.fog.color', scene.uuid).unwrap();
  if (fog instanceof Fog) {
    if (
      !Number.isFinite(Math.fround(fog.near)) ||
      !Number.isFinite(Math.fround(fog.far)) ||
      fog.near < 0 ||
      fog.far <= fog.near
    )
      invalid('Scene.fog.near/far', scene.uuid).unwrap();
    return {
      color,
      mode: FogModeValue.linear,
      near: fog.near,
      far: fog.far,
      density: 0,
      heightFalloff: 0,
      maxOpacity: 1,
      skyOpacity: 1,
    };
  }
  if (!Number.isFinite(Math.fround(fog.density)) || fog.density < 0)
    invalid('Scene.fog.density', scene.uuid).unwrap();
  return {
    color,
    mode: FogModeValue.exp2,
    density: fog.density,
    near: 0,
    far: 100,
    heightFalloff: 0,
    maxOpacity: 1,
    skyOpacity: 1,
  };
}

interface SourceTransform {
  readonly values: number[];
  readonly data: {
    pos: Float32Array;
    quat: Float32Array;
    scale: Float32Array;
  };
}

type TextureProjection = 0 | 1 | 2 | 3 | 4;
type TextureBuckets<T> = [
  Map<Texture, T>,
  Map<Texture, T>,
  Map<Texture, T> | undefined,
  Map<Texture, T> | undefined,
  Map<Texture, T> | undefined,
];
type TextureBindings = TextureBuckets<MaterialTextureValue>;

/** One sync's source walk and plans; prepare fills it, the deferred commit publishes it. */
interface ScenePreparation {
  readonly scene: Object3D;
  readonly camera: Camera;
  readonly buffers: SceneBuffers;
  readonly varianceShadow: boolean;
  /** Every reached source object plus the scene and camera; other nodes retire on commit. */
  readonly nodes: Set<Object3D>;
  readonly active: Set<Object3D>;
  /** Camera-layer matches plus admitted shadow casters. */
  readonly visible: Set<Object3D>;
  /** Camera-layer matches only. */
  readonly displayVisible: Set<Object3D>;
  readonly clipping: Map<Object3D, SourceClipping | undefined>;
  readonly groupOrders: Map<Object3D, number>;
  readonly transforms: Map<Object3D, SourceTransform>;
  readonly meshes: Map<Renderable, MeshPlan>;
  readonly texturePlans: TextureBuckets<TexturePlan>;
  readonly usedMaterials: readonly [Set<MaterialUse>, Set<MaterialUse>];
  readonly materialHandles: readonly [
    Map<MaterialUse, AssetHandle<'material'>>,
    Map<MaterialUse, AssetHandle<'material'>>,
  ];
  readonly geometryHandles: Map<Renderable, AssetHandle<'mesh'>>;
  readonly transparentRanks: Map<Object3D, number>;
  readonly uploadedTextures: Set<Texture>;
  cameraClipping: ClippingOptions | undefined;
  orderedOpaque?: boolean;
}

function createScenePreparation(
  scene: Object3D,
  camera: Camera,
  buffers: SceneBuffers,
  uploadedTextures: Set<Texture>,
): ScenePreparation {
  return {
    scene,
    camera,
    buffers,
    varianceShadow: buffers.shadowMap?.enabled === true && buffers.shadowMap.type === VSMShadowMap,
    nodes: new Set(),
    active: new Set(),
    visible: new Set(),
    displayVisible: new Set(),
    clipping: new Map(),
    groupOrders: new Map(),
    transforms: new Map(),
    meshes: new Map(),
    texturePlans: [new Map(), new Map(), undefined, undefined, undefined],
    usedMaterials: [new Set(), new Set()],
    materialHandles: [new Map(), new Map()],
    geometryHandles: new Map(),
    transparentRanks: new Map(),
    uploadedTextures,
    cameraClipping: undefined,
  };
}

/** Which source projection of a renderable's geometry this draw needs. */
interface GeometryShape {
  readonly topology: 'point-list' | 'line-list' | 'line-strip' | 'triangle-list';
  readonly grouped: boolean;
  readonly selection: readonly GeometryMaterial[];
  readonly wireframe: boolean;
  readonly uv: UvProjection;
  readonly flatMatcap: ReadonlySet<number>;
  readonly expanded: boolean;
  readonly cpuSkin: boolean;
  readonly morphColor: boolean;
}

/**
 * Match upstream's cache update boundary, including frozen matrices and cameras
 * whose parent lives outside the submitted root. Do not walk/update external parents.
 */
function updateSourceMatrices(scene: Object3D, camera: Camera, buffers: SceneBuffers): void {
  if (buffers.updateMatrices && scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
  if (buffers.updateMatrices && camera.parent === null && camera.matrixWorldAutoUpdate)
    camera.updateMatrixWorld();
}

function recordUpload(uploadedTextures: Set<Texture>, texture: Texture): void {
  const image = texture.image as { complete?: boolean } | null | undefined;
  if (texture.version > 0 && image != null && image.complete !== false)
    uploadedTextures.add(texture);
}

function castsShadow(object: Object3D, varianceShadow: boolean): boolean {
  return object.castShadow || (varianceShadow && object.receiveShadow);
}

function shadowCameraMasks(visible: ReadonlySet<Object3D>, camera: Camera): number[] {
  return [...visible]
    .filter(
      (object): object is DirectionalLight | PointLight | SpotLight =>
        (object instanceof DirectionalLight ||
          object instanceof PointLight ||
          object instanceof SpotLight) &&
        object.castShadow,
    )
    .map((light) =>
      (light.shadow.camera.layers.mask & 0xfffffffe) === 0
        ? camera.layers.mask
        : light.shadow.camera.layers.mask,
    );
}

function clippingCandidates(visible: ReadonlySet<Object3D>): Renderable[] {
  return [...visible]
    .filter(isRenderable)
    .filter((object) =>
      (Array.isArray(object.material) ? object.material : [object.material]).some(
        (material) => material?.visible,
      ),
    );
}

function sourceMatrix(object: Object3D, camera: Camera, scene: Object3D): number[] {
  if (object === camera) return camera.matrixWorldInverse.elements;
  if (object instanceof Sprite) {
    const override =
      scene instanceof Scene && object.material.allowOverride ? scene.overrideMaterial : null;
    const material = override !== null && isSpriteMaterial(override) ? override : object.material;
    const positionMaterial =
      surfaceInput(object.material, 'positionNode') !== null ? object.material : material;
    return spriteMatrix(object, camera, material, positionMaterial).elements;
  }
  return object.matrixWorld.elements;
}

function decomposeSourceMatrix(
  object: Object3D,
  camera: Camera,
  values: readonly number[],
): SourceTransform['data'] {
  // r187 removes camera scale when updating its view cache; manual view edits
  // and frozen inverses remain independent of the source world matrix.
  const matrix =
    object === camera ? camera.matrixWorldInverse.clone().invert().elements : [...values];
  // Three RectAreaLight emits along local -Z; native Rect emits along +Z.
  if (object instanceof RectAreaLight)
    for (let lane = 4; lane < 12; lane++) matrix[lane] = -(matrix[lane] ?? 0);
  const position = vec3.create(),
    rotation = quat.create(),
    scale = vec3.create(),
    shear = vec3.create();
  if (!mat4.decomposeAffine(position, rotation, scale, shear, matrix))
    unsupported(
      'Object3D matrixWorld requires a finite nonsingular affine matrix',
      object.uuid,
    ).unwrap();
  if (
    object === camera &&
    (scale.some((value) => Math.abs(value - 1) > 1e-5) ||
      shear.some((value) => Math.abs(value) > 1e-5))
  )
    unsupported(
      'Camera.matrixWorldInverse requires a rigid view; non-rigid views need native camera support',
      camera.uuid,
    ).unwrap();
  if (shear.some((value) => Math.abs(value) > 1e-5))
    unsupported(
      'Object3D matrixWorld with shear is not representable by Transform',
      object.uuid,
    ).unwrap();
  return { pos: position, quat: rotation, scale };
}

function isCulled(frame: ScenePreparation, object: Renderable, frustum: Frustum): boolean {
  return (
    object.frustumCulled &&
    !(frame.buffers.shadowMap?.enabled && castsShadow(object, frame.varianceShadow)) &&
    !(object instanceof Sprite
      ? frustum.intersectsSprite(object)
      : frustum.intersectsObject(object))
  );
}

function sourceTopology(object: Renderable): GeometryShape['topology'] {
  if (object instanceof Points) return 'point-list';
  if (object instanceof LineSegments) return 'line-list';
  return object instanceof Line ? 'line-strip' : 'triangle-list';
}

function primitiveSize(topology: GeometryShape['topology']): number {
  if (topology === 'triangle-list') return 3;
  return topology === 'line-list' || topology === 'line-strip' ? 2 : 1;
}

/** Select each drawn material slot once, in source group order. */
function selectMaterials(
  frame: ScenePreparation,
  object: Renderable,
  planes: ClippingOptions | undefined,
  coordinates: Map<Texture, ResolvedMaterialTextureCoordinates>,
  selection: GeometryMaterial[],
  list: MaterialUse[],
): void {
  const grouped = Array.isArray(object.material);
  const sourceList = grouped ? (object.material as Material[]) : [object.material as Material];
  const minimum = primitiveSize(sourceTopology(object));
  const available =
    object.geometry.index?.count ?? object.geometry.getAttribute('position')?.count ?? 0;
  const ranges = grouped
    ? object.geometry.groups
    : [{ materialIndex: 0, start: 0, count: available }];
  for (const range of ranges) {
    if (drawnCount(object.geometry, range, available) < minimum) continue;
    const slot = range.materialIndex ?? 0;
    const original = sourceList[slot];
    if (original === undefined || !original.visible || selection.some((item) => item.slot === slot))
      continue;
    const use = materialUse(frame, object, original, planes, coordinates);
    if (use === undefined) continue;
    selection.push({
      slot,
      vertexColors: use.effective.vertexColors,
      tangentBasis: materialTangentBasis(use.effective),
    });
    list.push(use);
  }
}

/** Only tangent-space consumers need a UV-derived frame; ordinary models share geometry. */
function materialTangentBasis(material: SupportedMaterial): 'normal' | 'uv' {
  return ('normalMap' in material && material.normalMap != null) ||
    ('bumpMap' in material && material.bumpMap != null) ||
    ('clearcoatNormalMap' in material && material.clearcoatNormalMap != null) ||
    ('anisotropyMap' in material && material.anisotropyMap != null) ||
    ('anisotropy' in material && material.anisotropy !== 0) ||
    ('normalNode' in material && material.normalNode != null) ||
    ('clearcoatNormalNode' in material && material.clearcoatNormalNode != null)
    ? 'uv'
    : 'normal';
}

/** Elements of one group that survive the geometry drawRange. */
function drawnCount(
  geometry: BufferGeometry,
  range: { readonly start: number; readonly count: number },
  available: number,
): number {
  const first = Math.max(0, range.start, geometry.drawRange.start);
  const last = Math.min(
    available,
    range.start + range.count,
    geometry.drawRange.start + geometry.drawRange.count,
  );
  return last - first;
}

/** The validated material one slot draws with, or undefined when the requested buffers skip it. */
function materialUse(
  frame: ScenePreparation,
  object: Renderable,
  original: Material,
  planes: ClippingOptions | undefined,
  coordinates: Map<Texture, ResolvedMaterialTextureCoordinates>,
): MaterialUse | undefined {
  const scene = frame.scene;
  const material =
    scene instanceof Scene && original.allowOverride
      ? (scene.overrideMaterial ?? original)
      : original;
  const inheritedPosition = surfaceInput(original, 'positionNode');
  if (material !== original && inheritedPosition !== null && !('isNodeMaterial' in material))
    admitSurfaceInput(original, 'positionNode', inheritedPosition).unwrap();
  const source = validateMaterial(effectiveMaterial(material, original, frame.buffers)).unwrap();
  if (isBlended(source) ? !frame.buffers.transparent : !frame.buffers.opaque) return undefined;
  const shading = Number(usesFlatShading(source, object.geometry.hasAttribute('normal'))) as 0 | 1;
  const shadowOnly = !frame.displayVisible.has(object);
  return {
    source: material,
    effective: source,
    shading,
    skinned: object instanceof SkinnedMesh && isBasicMaterial(source),
    shadowOnly,
    coordinates,
    variant: JSON.stringify([
      material === original ? '' : original.uuid,
      planes,
      object instanceof SkinnedMesh,
      shadowOnly,
    ]),
    ...(planes === undefined ? {} : { clipping: planes }),
  };
}

/** r187 inherits alpha coverage and transparency from each source draw when overriding. */
function effectiveMaterial(
  material: Material,
  original: Material,
  buffers: SceneBuffers,
): Material {
  if (material !== original && 'isNodeMaterialInstance' in material)
    unsupported('NodeMaterialInstance scene override', material.uuid).unwrap();
  return Object.assign(
    Object.create(material),
    material === original
      ? {}
      : {
          // r187 inherits source position nodes, but keeps override rotation/scale.
          positionNode:
            surfaceInput(original, 'positionNode') ?? surfaceInput(material, 'positionNode'),
          alphaTest: original.alphaTest,
          alphaMap: 'alphaMap' in original ? original.alphaMap : null,
          transparent: isBlended(original),
        },
    buffers.depth ? {} : { depthTest: false, depthWrite: false },
    buffers.stencil ? {} : { stencilWrite: false },
  );
}

function isBlended(material: Material): boolean {
  return material.transparent || usesTransmission(material);
}

function isWireframe(object: Renderable, list: readonly MaterialUse[]): boolean {
  const wireframe = list.some((use) => 'wireframe' in use.effective && use.effective.wireframe);
  if (wireframe && list.some((use) => !('wireframe' in use.effective) || !use.effective.wireframe))
    unsupported(
      'Mixed solid/wireframe groups require native per-submesh line expansion',
      object.uuid,
    ).unwrap();
  return wireframe;
}

function rejectOrderedOpaque(
  frame: ScenePreparation,
  object: Renderable,
  list: readonly MaterialUse[],
): void {
  if (
    (object.renderOrder !== 0 || (frame.groupOrders.get(object) ?? 0) !== 0) &&
    list.some((use) => !use.shadowOnly && !isBlended(use.effective))
  ) {
    if (!frame.buffers.opaqueOrder)
      unsupported('Opaque renderOrder requires renderer-owned ordering', object.uuid).unwrap();
    frame.orderedOpaque = true;
  }
}

const scalarColorParameters: readonly string[] = [
  'baseColorTexture',
  'emissiveTexture',
  'specularColorTexture',
  'sheenColorTexture',
];
const scalarRedParameters: readonly string[] = [
  'alphaTexture',
  'bumpTexture',
  'displacementTexture',
  'occlusionTexture',
  'transmissionTexture',
  'clearcoatTexture',
  'iridescenceTexture',
];

/** Share existing orientation caches; scalar variants are created only when actually used. */
function textureProjection(
  material: SupportedMaterial,
  parameter: string,
  texture: Texture,
): TextureProjection {
  const sphere = isMatcapMaterial(material) && parameter === 'baseColorTexture';
  if (texture.format !== RedFormat) return sphere ? 1 : 0;
  if (scalarColorParameters.includes(parameter)) return sphere ? 3 : 2;
  if (scalarRedParameters.includes(parameter)) return 0;
  return 4;
}

function uvTextures(list: readonly MaterialUse[]): Texture[] {
  const textures: Texture[] = [];
  for (const use of list) {
    // The sphere image uses generated coordinates. Without coverage, preserve
    // the default Matcap path without enumerating or allocating texture slots.
    if (isMatcapMaterial(use.effective)) {
      if (use.effective.alphaMap != null) textures.push(use.effective.alphaMap);
      continue;
    }
    for (const [, texture] of materialTextures(use.effective)) textures.push(texture);
  }
  return textures;
}

function flatMatcapSlots(list: readonly MaterialUse[]): Set<number> {
  return new Set(
    list.flatMap((use, slot) =>
      isMatcapMaterial(use.effective) && use.shading === 1 ? [slot] : [],
    ),
  );
}

function expandsInstances(object: Renderable): boolean {
  return (
    object instanceof BatchedMesh ||
    (object instanceof InstancedMesh &&
      (object.instanceColor !== null || object.morphTexture !== null))
  );
}

function geometryVariant(object: Renderable, shape: GeometryShape): string {
  const perObject =
    shape.expanded || shape.cpuSkin || shape.flatMatcap.size > 0 || shape.morphColor;
  return JSON.stringify([
    shape.topology,
    shape.grouped,
    shape.selection,
    perObject ? object.uuid : '',
    shape.wireframe,
    shape.uv.values,
    [...shape.flatMatcap],
  ]);
}

function geometryCacheValues(
  object: Renderable,
  shape: GeometryShape,
  camera: Camera,
  firstMaterial: SupportedMaterial | undefined,
): unknown[] {
  const values = geometryValues(object.geometry, shape.grouped);
  if (shape.cpuSkin) values.push(...cpuSkinValues(object as SkinnedMesh));
  if ((shape.flatMatcap.size > 0 || shape.morphColor) && object instanceof Mesh)
    values.push(...(object.morphTargetInfluences ?? []));
  if (shape.expanded && firstMaterial !== undefined)
    values.push(
      ...instanceGeometryValues(object as InstancedMesh | BatchedMesh, camera, firstMaterial),
    );
  return values;
}

function projectMeshGeometry(object: Renderable, shape: GeometryShape): MeshAsset | undefined {
  let base = projectGeometry(
    object.geometry,
    shape.grouped,
    shape.selection,
    shape.topology,
    shape.uv.attributes,
    shape.wireframe,
    sourceMorphColorWeights(object, shape.morphColor),
  ).unwrap();
  if (base === undefined) return undefined;
  if (shape.cpuSkin) base = projectCpuSkin(object as SkinnedMesh, base);
  if (shape.expanded) base = projectInstanceGeometry(object as InstancedMesh | BatchedMesh, base);
  if (base !== undefined && shape.flatMatcap.size > 0)
    base = projectFlatNormals(
      base,
      shape.flatMatcap,
      object instanceof Mesh ? object.morphTargetInfluences : undefined,
    );
  return base;
}

function projectLinePointMaterial(
  object: Line | Points,
  source: SupportedMaterial,
  coordinates: Map<Texture, ResolvedMaterialTextureCoordinates>,
): void {
  if (!(isLineMaterial(source) || isPointsMaterial(source)))
    unsupported('Lines/Points require their unlit material family', object.uuid).unwrap();
  if (object instanceof Line && source.vertexColors && object.geometry.hasAttribute('color'))
    unsupported('Native Lines do not transport per-vertex colors', object.uuid).unwrap();
  for (const [parameter, texture] of materialTextures(source)) {
    if (
      !(
        object instanceof Points &&
        source instanceof PointsMaterial &&
        parameter === 'baseColorTexture'
      )
    )
      unsupported(
        'Native Lines/Points do not transport source UV or point coordinates for this texture slot',
        object.uuid,
      ).unwrap();
    if (object.geometry.hasAttribute('uv'))
      unsupported(
        'PointsMaterial.map with a geometry UV needs per-point sampling',
        object.uuid,
      ).unwrap();
    const { transform } = textureCoordinates(texture).unwrap();
    // Three's sprite coordinate has its origin at the lower left. Flip the
    // generated coordinates, while sharing the original texture publication.
    const [sx, sy] = transform.scale;
    const [x, y] = transform.offset;
    coordinates.set(texture, {
      set: 0,
      transform: {
        offset: [x - Math.sin(transform.rotation) * sy, y + Math.cos(transform.rotation) * sy],
        scale: [sx, -sy],
        rotation: transform.rotation,
      },
    });
  }
}

function pointStyle(object: Points, frame: ScenePreparation, list: readonly MaterialUse[]) {
  const source = list.find(({ effective }) => effective instanceof PointsMaterial)?.effective;
  if (!(source instanceof PointsMaterial))
    return { size: 1, sizeUnits: PointSizeUnitsValue.pixels, minPixelSize: 0 };
  if (
    list.some(
      ({ effective }) =>
        !(effective instanceof PointsMaterial) ||
        effective.size !== source.size ||
        effective.sizeAttenuation !== source.sizeAttenuation,
    )
  )
    unsupported(
      'Points material groups need the same raster size and attenuation',
      object.uuid,
    ).unwrap();
  const projection = frame.camera.projectionMatrix.elements;
  const world = source.sizeAttenuation && projection[11] === -1;
  const size = world
    ? source.size / Math.abs(projection[5])
    : source.size * (frame.buffers.pixelRatio ?? 1);
  if (!Number.isFinite(Math.fround(size)) || Math.fround(size) <= 0)
    invalid('PointsMaterial.size', source.uuid).unwrap();
  return {
    size,
    sizeUnits: world ? PointSizeUnitsValue.world : PointSizeUnitsValue.pixels,
    minPixelSize: 1,
  };
}

function meshLineStyle(
  object: Renderable,
  payload: MeshAsset,
  list: readonly MaterialUse[],
  wireframe: boolean,
): ReturnType<typeof lineStyle> | undefined {
  if (object instanceof Line)
    return lineStyle(
      object,
      payload,
      list.map((use) => use.effective),
    );
  return wireframe ? { dashSize: 1, gapSize: 0, dashOffset: 0 } : undefined;
}

function instanceSourceValues(object: InstancedMesh, expanded: boolean): readonly unknown[] {
  if (
    !Number.isInteger(object.count) ||
    object.count < 0 ||
    object.count > object.instanceMatrix.count
  )
    invalid('InstancedMesh.count', object.uuid).unwrap();
  return [
    object.instanceMatrix,
    object.instanceMatrix.array,
    object.instanceMatrix.version,
    object.count,
    expanded,
  ];
}

function projectsMorphColor(
  geometry: BufferGeometry,
  materials: readonly GeometryMaterial[],
): boolean {
  return (
    geometry.morphAttributes.color !== undefined &&
    materials.some((material) => material.vertexColors)
  );
}

function meshMorphWeights(object: Renderable, payload: MeshAsset): Float32Array | undefined {
  if (payload.morphTargets === undefined) return undefined;
  const morphWeights = new Float32Array(
    object instanceof Mesh
      ? (object.morphTargetInfluences ??
          (object instanceof InstancedMesh
            ? Array.from({ length: payload.morphTargets.length }, () => 0)
            : []))
      : [],
  );
  if (morphWeights.length !== payload.morphTargets.length || !morphWeights.every(Number.isFinite))
    invalid('Mesh.morphTargetInfluences', object.uuid).unwrap();
  return morphWeights;
}

/** Material cache identity contributed by one bound texture parameter. */
function bindingValues(
  binding: MaterialTextureValue,
  coordinates: ResolvedMaterialTextureCoordinates | undefined,
): unknown[] {
  return [
    binding.texture ?? binding.source,
    binding.sampler,
    coordinates?.set ?? 0,
    ...(coordinates?.transform?.offset ?? [0, 0]),
    ...(coordinates?.transform?.scale ?? [1, 1]),
    coordinates?.transform?.rotation ?? 0,
  ];
}

function sceneAmbientIrradiance(
  scene: Object3D,
  visible: ReadonlySet<Object3D>,
): [number, number, number] {
  const ambientIrradiance: [number, number, number] = [0, 0, 0];
  for (const object of visible) {
    if (!(object instanceof AmbientLight)) continue;
    ambientIrradiance[0] = ambientIrradiance[0] + object.color.r * object.intensity;
    ambientIrradiance[1] = ambientIrradiance[1] + object.color.g * object.intensity;
    ambientIrradiance[2] = ambientIrradiance[2] + object.color.b * object.intensity;
  }
  if (!ambientIrradiance.every((value) => Number.isFinite(Math.fround(value))))
    invalid('AmbientLight total irradiance', scene.uuid).unwrap();
  return ambientIrradiance;
}

/** Preserve native batching until the caller explicitly requests opaque ordering. */
function rankOpaqueMeshes(frame: ScenePreparation): void {
  if (!frame.buffers.opaqueOrder) return;
  if (!frame.orderedOpaque && frame.buffers.sortObjects && frame.buffers.opaqueSort == null) return;
  const plans = [...frame.meshes.values()].filter((plan) =>
    plan.materials.some((use) => !use.shadowOnly && !isBlended(use.effective)),
  );
  // Keep the priorities below the native transparent queue (3000).
  if (plans.length > 1000)
    unsupported('Ordered opaque draws support at most 1000 objects per scene').unwrap();
  const projection = new Matrix4().multiplyMatrices(
    frame.camera.projectionMatrix,
    frame.camera.matrixWorldInverse,
  );
  const items = plans.map((plan) => {
    if (
      !(plan.source instanceof Mesh) ||
      plan.source instanceof InstancedMesh ||
      plan.source instanceof BatchedMesh ||
      Array.isArray(plan.source.material) ||
      plan.materials.length !== 1 ||
      frame.clipping.get(plan.source) !== undefined
    )
      unsupported(
        'Opaque ordering requires single-material, unclipped ordinary meshes',
        plan.source.uuid,
      ).unwrap();
    return { plan, item: sourceRenderItem(frame, plan, projection) };
  });
  if (frame.buffers.sortObjects) {
    const compare = frame.buffers.opaqueSort ?? painterSort;
    items.sort((a, b) => compare(a.item, b.item));
  }
  for (const [rank, { plan }] of items.entries()) {
    const use = plan.materials[0];
    if (use === undefined) throw new Error('ordered mesh has no material');
    // Object identity, rather than rank, keeps asset handles stable after reordering.
    use.variant += `:opaque:${plan.source.uuid}`;
    use.queue = 2000 + rank;
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

function withOpaqueQueue(material: MaterialAsset, queue: number): MaterialAsset {
  if (material.parent !== undefined) throw new Error('ordered material must own its passes');
  const [first, ...rest] = (material.passes ?? []).map((pass) =>
    pass.name === 'shadow-caster' ? pass : { ...pass, renderState: { ...pass.renderState, queue } },
  );
  if (first === undefined) throw new Error('ordered material has no concrete passes');
  return { ...material, passes: [first, ...rest] };
}

/** r187 StandardDrawingPipeline uses clip-space Z without division by W. */
function sourceRenderItem(
  frame: ScenePreparation,
  plan: MeshPlan,
  projection: Matrix4,
): RenderItem {
  const geometry = plan.source.geometry;
  const bounds = plan.source instanceof SkinnedMesh ? plan.source : geometry;
  if (bounds.boundingSphere === null) bounds.computeBoundingSphere();
  const localCenter = bounds.boundingSphere?.center;
  const center =
    plan.source instanceof Sprite
      ? new Vector4().setFromMatrixPosition(plan.source.matrixWorld)
      : new Vector4()
          .set(localCenter?.x ?? 0, localCenter?.y ?? 0, localCenter?.z ?? 0, 1)
          .applyMatrix4(plan.source.matrixWorld);
  center.applyMatrix4(projection);
  return {
    id: plan.source.id,
    object: plan.source,
    geometry,
    material: plan.materials[0]?.source ?? null,
    groupOrder: frame.groupOrders.get(plan.source) ?? 0,
    renderOrder: plan.source.renderOrder,
    z: center.z,
    group: null,
    clippingContext: null,
  };
}

/**
 * Native layers express the source transparent order even when camera depth
 * differs from world Z. Opaque ordering remains a separate native contract.
 */
function rankTransparentMeshes(frame: ScenePreparation): void {
  const transparent = [...frame.meshes.values()].filter((plan) =>
    plan.materials.some((use) => isBlended(use.effective)),
  );
  if (frame.buffers.sortObjects && frame.buffers.transparentSort != null) {
    rankCustomTransparent(frame, transparent, frame.buffers.transparentSort);
    return;
  }
  const depths = new Map(transparent.map((plan) => [plan, sourceDepth(plan, frame.camera)]));
  const groupOrders = frame.groupOrders;
  if (frame.buffers.sortObjects)
    transparent.sort(
      (a, b) =>
        (groupOrders.get(a.source) ?? 0) - (groupOrders.get(b.source) ?? 0) ||
        a.source.renderOrder - b.source.renderOrder ||
        (depths.get(a) ?? 0) - (depths.get(b) ?? 0) ||
        a.source.id - b.source.id,
    );
  for (const [rank, plan] of transparent.entries()) frame.transparentRanks.set(plan.source, rank);
}

function sourceDepth(plan: MeshPlan, camera: Camera): number {
  if (plan.source instanceof Sprite)
    return new Vector3()
      .setFromMatrixPosition(plan.source.matrixWorld)
      .applyMatrix4(camera.matrixWorldInverse).z;
  const geometry = plan.source.geometry;
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  return (geometry.boundingSphere?.center.clone() ?? new Vector3())
    .applyMatrix4(plan.source.matrixWorld)
    .applyMatrix4(camera.matrixWorldInverse).z;
}

/** Caller render items are created only when an explicit comparator is installed. */
function rankCustomTransparent(
  frame: ScenePreparation,
  plans: MeshPlan[],
  compare: (a: RenderItem, b: RenderItem) => number,
): void {
  const projection = new Matrix4().multiplyMatrices(
    frame.camera.projectionMatrix,
    frame.camera.matrixWorldInverse,
  );
  const items = plans.map((plan): RenderItem => {
    if (plan.materials.length !== 1 || frame.clipping.get(plan.source) !== undefined)
      unsupported(
        'Custom transparent sorting requires single-material, unclipped objects',
        plan.source.uuid,
      ).unwrap();
    return sourceRenderItem(frame, plan, projection);
  });
  items.sort(compare);
  for (const [rank, item] of items.entries())
    if (item.object !== null) frame.transparentRanks.set(item.object, rank);
}

function sourceMorphColorWeights(
  object: Renderable,
  enabled: boolean,
): readonly number[] | undefined {
  if (!enabled) return undefined;
  if (!(object instanceof Mesh) || object instanceof InstancedMesh || object instanceof BatchedMesh)
    return unsupported(
      'Per-instance color morphs require native GPU color target channels',
      object.uuid,
    ).unwrap();
  if (object.morphTargetInfluences === undefined)
    return invalid('Mesh.morphTargetInfluences for color morphs', object.uuid).unwrap();
  return object.morphTargetInfluences;
}
