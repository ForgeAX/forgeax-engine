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
  Instances,
  Layer,
  MeshFilter,
  MeshRenderer,
  Camera as NativeCamera,
  DirectionalLight as NativeDirectionalLight,
  Lines as NativeLines,
  PointLight as NativePointLight,
  PointLightShadow as NativePointLightShadow,
  Points as NativePoints,
  RectAreaLight as NativeRectAreaLight,
  SpotLight as NativeSpotLight,
  ShadowParticipation,
  SkyboxBackground,
  Skylight,
} from '@forgeax/engine-render';
import { MorphWeights, Name, propagateTransforms, Transform } from '@forgeax/engine-scene';
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
import {
  AmbientLight,
  BatchedMesh,
  type BufferGeometry,
  Camera,
  Color,
  DirectionalLight,
  Frustum,
  Group,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineSegments,
  LOD,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  Object3D,
  PointLight,
  Points,
  PointsMaterial,
  Quaternion,
  RectAreaLight,
  Scene,
  type Skeleton,
  SkinnedMesh,
  SpotLight,
  Sprite,
  type Texture,
  Vector3,
  VSMShadowMap,
} from 'three/src/Three.Core.js';
import { objectClipping, projectClipping, type SourceClipping } from './clipping';
import { projectEnvironment, scaleEnvironment } from './environment';
import { invalid, unsupported } from './errors';
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
  readonly variant: string;
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
  readonly lineStyle: NonNullable<ReturnType<typeof lineStyle>> | undefined;
  readonly skin:
    | { skeleton: AssetHandle<'skeleton'>; joints: ReturnType<typeof projectJoints> }
    | undefined;
}
interface TexturePlan {
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
  depth: boolean;
  stencil: boolean;
  sortObjects: boolean;
  opaque: boolean;
  transparent: boolean;
  updateMatrices: boolean;
  shadowMap?: ShadowMapSettings;
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
  ) {
    this.world = new World({ assets });
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
      for (const cache of caches) cache.commit();
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
    if (scene.fog !== null)
      return unsupported('Scene fog requires the native Three depth-fog law', scene.uuid).unwrap();
    if (
      scene.background !== null &&
      !(scene.background instanceof Color) &&
      scene.backgroundBlurriness !== 0
    )
      return unsupported(
        'Scene.backgroundBlurriness requires native sky roughness/LOD controls',
        scene.uuid,
      ).unwrap();
    const lighting = this.environmentHandle(scene.environment, 1, uploadedTextures);
    const background =
      scene.background instanceof Color
        ? NO_EQUIRECT
        : this.environmentHandle(scene.background, scene.backgroundIntensity, uploadedTextures);
    const lightingRotation = new Quaternion().setFromEuler(scene.environmentRotation).toArray();
    const backgroundRotation = new Quaternion().setFromEuler(scene.backgroundRotation).toArray();
    if (!Number.isFinite(scene.environmentIntensity) || scene.environmentIntensity < 0)
      return invalid('Scene.environmentIntensity', scene.uuid).unwrap();
    return { lighting, background, lightingRotation, backgroundRotation };
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
      const values = sourceMatrix(object, camera);
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
    const uv = projectUvs(object.geometry, uvTextures(list));
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
    };
    const variant = geometryVariant(object, shape);
    const values = geometryCacheValues(object, shape, frame.camera, list[0]?.effective);
    const payload =
      this.geometry.read(object.geometry, values, variant)?.payload ??
      projectMeshGeometry(object, shape);
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
    });
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
    if (use.clipping !== undefined && (object instanceof Line || object instanceof Points))
      unsupported('Native Lines/Points support camera clipping only', object.uuid).unwrap();
    if (frame.clipping.get(object) !== undefined && source.alphaToCoverage)
      unsupported(
        'ClippingGroup alphaToCoverage requires native smooth clipping coverage',
        object.uuid,
      ).unwrap();
    if (object instanceof Line || object instanceof Points) rejectLinePointMaterial(object, source);
    if (source instanceof MeshNormalMaterial && !object.geometry.hasAttribute('normal'))
      unsupported('Normal/Matcap without normals requires flat shading', object.uuid).unwrap();
    frame.usedMaterials[use.shading].add(use);
    const orientation = source instanceof MeshMatcapMaterial ? 1 : 0;
    for (const [, texture] of materialTextures(source)) {
      if (frame.texturePlans[orientation].has(texture) || isExternalTexture(texture)) continue;
      frame.texturePlans[orientation].set(texture, this.planTexture(texture, orientation));
    }
  }

  private planTexture(texture: Texture, orientation: 0 | 1): TexturePlan {
    validateTexture(texture).unwrap();
    if (
      orientation === 1 &&
      texture.matrix.elements.some((value, index) => value !== (index % 4 === 0 ? 1 : 0))
    )
      unsupported('Matcap Texture UV transform', texture.uuid).unwrap();
    const values = textureValues(texture),
      samplerSignature = samplerValues(texture);
    return {
      source: texture,
      values,
      samplerValues: samplerSignature,
      payload:
        this.textures[orientation].read(texture, values)?.payload ??
        projectTextureUpload(
          texture,
          this.textures[orientation].read(texture, undefined)?.payload,
          orientation === 1 ? !texture.flipY : texture.flipY,
        ).unwrap(),
      sampler:
        this.samplers.read(texture, samplerSignature)?.payload ?? projectSampler(texture).unwrap(),
    };
  }

  private publishTextures(frame: ScenePreparation): TextureBindings {
    const textureBindings = [
      new Map<Texture, MaterialTextureValue>(),
      new Map<Texture, MaterialTextureValue>(),
    ] as const;
    for (const orientation of [0, 1] as const) {
      for (const plan of frame.texturePlans[orientation].values()) {
        const previous = this.textures[orientation].read(plan.source, plan.values);
        const texture =
          previous ?? this.textures[orientation].write(plan.source, plan.values, plan.payload);
        if (previous === undefined) recordUpload(frame.uploadedTextures, plan.source);
        const sampler =
          this.samplers.read(plan.source, plan.samplerValues) ??
          this.samplers.write(plan.source, plan.samplerValues, plan.sampler);
        textureBindings[orientation].set(plan.source, {
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
        const values = [...materialValues(source), frame.varianceShadow];
        for (const [parameter, texture] of materialTextures(source)) {
          const binding = this.textureBinding(use, texture, textureBindings);
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
    texture: Texture,
    textureBindings: TextureBindings,
  ): MaterialTextureValue {
    const binding = isExternalTexture(texture)
      ? ({
          ...(this.external?.binding(texture) ??
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
      : textureBindings[use.effective instanceof MeshMatcapMaterial ? 1 : 0].get(texture);
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
    propagateTransforms(this.world).unwrap();
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
    this.ensure(sceneEntity, Skylight, { intensity: 0 });
    this.write(sceneEntity, Skylight, {
      ambientIrradiance,
      equirect: lighting.lighting,
      intensity: lighting.lighting !== 0 && scene instanceof Scene ? scene.environmentIntensity : 0,
      rotation: lighting.lightingRotation,
    });
    if (lighting.background !== 0) {
      this.ensure(sceneEntity, SkyboxBackground);
      this.write(sceneEntity, SkyboxBackground, {
        equirect: lighting.background,
        rotation: lighting.backgroundRotation,
      });
    } else this.removeIfPresent(sceneEntity, SkyboxBackground);
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
    for (const joint of record.joints ?? []) this.world.despawn(joint).unwrap();
    this.world.despawn(record.entity).unwrap();
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
    const changed = Object.entries(data).some(([name, value]) => {
      const type = component.fields[name]?.type;
      const f32 = type === 'f32' || type?.startsWith('array<f32') === true;
      const equal = (stored: unknown, source: unknown) =>
        Object.is(stored, f32 && typeof source === 'number' ? Math.fround(source) : source);
      if (Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))) {
        const source = value as ArrayLike<number>;
        const stored = current[name] as ArrayLike<number>;
        if (stored.length !== source.length) return true;
        for (let i = 0; i < source.length; i++) if (!equal(stored[i], source[i])) return true;
        return false;
      }
      return !equal(current[name], value);
    });
    if (changed) this.world.set(entity, component, data).unwrap();
  }

  sources(): ThreeSourceIdentity[] {
    return [...this.nodes].map(([source, record]) => ({
      uuid: source.uuid,
      name: source.name,
      type: source.type,
      entityKey: record.entity,
    }));
  }

  dispose(): void {
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
        'Group',
        'LOD',
        'Mesh',
        'InstancedMesh',
        'BatchedMesh',
        'SkinnedMesh',
        'Bone',
        'Line',
        'LineSegments',
        'Points',
        'Sprite',
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
        ![object.distance, object.decay].every((value) => Number.isFinite(value) && value >= 0)
      )
        invalid('Light distance/decay', object.uuid).unwrap();
      if (object instanceof SpotLight) {
        if (
          !Number.isFinite(object.angle) ||
          object.angle <= 0 ||
          object.angle > Math.PI / 2 ||
          !Number.isFinite(object.penumbra) ||
          object.penumbra < 0 ||
          object.penumbra > 1
        )
          invalid('SpotLight angle/penumbra', object.uuid).unwrap();
        if (object.map !== null || object.decay !== 2)
          unsupported('SpotLight map/non-default decay', object.uuid).unwrap();
      }
    }
  }
}

const NO_EQUIRECT = 0 as AssetHandle<'equirect'>;

interface SceneLighting {
  readonly lighting: AssetHandle<'equirect'>;
  readonly background: AssetHandle<'equirect'>;
  readonly lightingRotation: number[];
  readonly backgroundRotation: number[];
}

interface SourceTransform {
  readonly values: number[];
  readonly data: {
    pos: Float32Array;
    quat: Float32Array;
    scale: Float32Array;
    shear: Float32Array;
  };
}

type TextureBindings = readonly [
  Map<Texture, MaterialTextureValue>,
  Map<Texture, MaterialTextureValue>,
];

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
  readonly texturePlans: readonly [Map<Texture, TexturePlan>, Map<Texture, TexturePlan>];
  readonly usedMaterials: readonly [Set<MaterialUse>, Set<MaterialUse>];
  readonly materialHandles: readonly [
    Map<MaterialUse, AssetHandle<'material'>>,
    Map<MaterialUse, AssetHandle<'material'>>,
  ];
  readonly geometryHandles: Map<Renderable, AssetHandle<'mesh'>>;
  readonly transparentRanks: Map<Object3D, number>;
  readonly uploadedTextures: Set<Texture>;
  cameraClipping: ClippingOptions | undefined;
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
    texturePlans: [new Map(), new Map()],
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

function sourceMatrix(object: Object3D, camera: Camera): number[] {
  if (object === camera) return camera.matrixWorldInverse.elements;
  return object instanceof Sprite
    ? spriteMatrix(object, camera).elements
    : object.matrixWorld.elements;
}

function decomposeSourceMatrix(
  object: Object3D,
  camera: Camera,
  values: readonly number[],
): SourceTransform['data'] {
  // r184 removes camera scale when updating its view cache; manual view edits
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
  return { pos: position, quat: rotation, scale, shear };
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
    selection.push({ slot, vertexColors: use.effective.vertexColors });
    list.push(use);
  }
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
  const source = validateMaterial(effectiveMaterial(material, original, frame.buffers)).unwrap();
  if (isBlended(source) ? !frame.buffers.transparent : !frame.buffers.opaque) return undefined;
  const shading = Number(usesFlatShading(source, object.geometry.hasAttribute('normal'))) as 0 | 1;
  const shadowOnly = !frame.displayVisible.has(object);
  return {
    source: material,
    effective: source,
    shading,
    skinned: object instanceof SkinnedMesh && source instanceof MeshBasicMaterial,
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

/** r184 inherits alpha coverage and transparency from each source draw when overriding. */
function effectiveMaterial(
  material: Material,
  original: Material,
  buffers: SceneBuffers,
): Material {
  return Object.assign(
    Object.create(material),
    material === original
      ? {}
      : {
          alphaTest: original.alphaTest,
          alphaMap: 'alphaMap' in original ? original.alphaMap : null,
          transparent: isBlended(original),
        },
    buffers.depth ? {} : { depthTest: false, depthWrite: false },
    buffers.stencil ? {} : { stencilWrite: false },
  );
}

function isBlended(material: Material): boolean {
  return material.transparent || ('transmission' in material && Number(material.transmission) > 0);
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
    list.some((use) => !use.effective.transparent)
  )
    unsupported('Opaque renderOrder requires native ordered opaque draws', object.uuid).unwrap();
}

function uvTextures(list: readonly MaterialUse[]): Texture[] {
  return list.flatMap((use) =>
    use.effective instanceof MeshMatcapMaterial
      ? []
      : materialTextures(use.effective).map(([, texture]) => texture),
  );
}

function flatMatcapSlots(list: readonly MaterialUse[]): Set<number> {
  return new Set(
    list.flatMap((use, slot) =>
      use.effective instanceof MeshMatcapMaterial && use.shading === 1 ? [slot] : [],
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
  const perObject = shape.expanded || shape.cpuSkin || shape.flatMatcap.size > 0;
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
  if (shape.flatMatcap.size > 0 && object instanceof Mesh)
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

function rejectLinePointMaterial(object: Line | Points, source: SupportedMaterial): void {
  if (!(source instanceof LineBasicMaterial || source instanceof PointsMaterial))
    unsupported('Lines/Points require their unlit material family', object.uuid).unwrap();
  if (source.vertexColors && object.geometry.hasAttribute('color'))
    unsupported('Native Lines/Points do not transport per-vertex colors', object.uuid).unwrap();
  if (materialTextures(source).length > 0)
    unsupported(
      'Native Lines/Points do not transport source UV or point coordinates',
      object.uuid,
    ).unwrap();
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

/**
 * Native layers express the source transparent order even when camera depth
 * differs from world Z. Opaque ordering remains a separate native contract.
 */
function rankTransparentMeshes(frame: ScenePreparation): void {
  const transparent = [...frame.meshes.values()].filter((plan) =>
    plan.materials.some((use) => isBlended(use.effective)),
  );
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
