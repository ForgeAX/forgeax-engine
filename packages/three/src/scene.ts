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
import { projectUvs } from './uv-projection';

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
  readonly instanceValues?: readonly unknown[];
  readonly instances?: Float32Array;
  readonly nativeInstances?: boolean;
  readonly morphWeights?: Float32Array;
  readonly lineStyle?: NonNullable<ReturnType<typeof lineStyle>>;
  readonly skin?: { skeleton: AssetHandle<'skeleton'>; joints: ReturnType<typeof projectJoints> };
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
    const uploaded = (texture: Texture): void => {
      const image = texture.image as { complete?: boolean } | null | undefined;
      if (texture.version > 0 && image != null && image.complete !== false)
        uploadedTextures.add(texture);
    };
    if (scene instanceof Scene && scene.fog !== null)
      return unsupported('Scene fog requires the native Three depth-fog law', scene.uuid).unwrap();
    if (
      scene instanceof Scene &&
      scene.background !== null &&
      !(scene.background instanceof Color) &&
      scene.backgroundBlurriness !== 0
    )
      return unsupported(
        'Scene.backgroundBlurriness requires native sky roughness/LOD controls',
        scene.uuid,
      ).unwrap();
    const environment = (texture: Texture | null, intensity = 1): AssetHandle<'equirect'> => {
      if (texture === null) return 0 as AssetHandle<'equirect'>;
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
      if (previous === undefined) uploaded(texture);
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
    };
    const lighting =
      scene instanceof Scene ? environment(scene.environment) : (0 as AssetHandle<'equirect'>);
    const background =
      scene instanceof Scene && scene.background !== null && !(scene.background instanceof Color)
        ? environment(scene.background, scene.backgroundIntensity)
        : (0 as AssetHandle<'equirect'>);
    const lightingRotation =
      scene instanceof Scene
        ? new Quaternion().setFromEuler(scene.environmentRotation).toArray()
        : [0, 0, 0, 1];
    const backgroundRotation =
      scene instanceof Scene
        ? new Quaternion().setFromEuler(scene.backgroundRotation).toArray()
        : [0, 0, 0, 1];
    if (
      scene instanceof Scene &&
      (!Number.isFinite(scene.environmentIntensity) || scene.environmentIntensity < 0)
    )
      return invalid('Scene.environmentIntensity', scene.uuid).unwrap();
    const varianceShadow =
      buffers.shadowMap?.enabled === true && buffers.shadowMap.type === VSMShadowMap;
    const castsShadow = (object: Object3D) =>
      object.castShadow || (varianceShadow && object.receiveShadow);
    const nodes = new Set<Object3D>();
    const visible = new Set<Object3D>();
    const activeObjects = new Set<Object3D>();
    const displayVisible = new Set<Object3D>();
    const meshes = new Map<Renderable, MeshPlan>();
    const texturePlans = [
      new Map<Texture, TexturePlan>(),
      new Map<Texture, TexturePlan>(),
    ] as const;
    const usedMaterials = [new Set<MaterialUse>(), new Set<MaterialUse>()] as const;
    const clipping = new Map<Object3D, SourceClipping | undefined>();
    const groupOrders = new Map<Object3D, number>();
    // Match upstream's cache update boundary, including frozen matrices and cameras
    // whose parent lives outside the submitted root. Do not walk/update external parents.
    if (buffers.updateMatrices && scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (buffers.updateMatrices && camera.parent === null && camera.matrixWorldAutoUpdate)
      camera.updateMatrixWorld();
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem,
      camera.reversedDepth,
    );
    const visit = (
      object: Object3D,
      parentVisible = true,
      parentClipping?: SourceClipping,
      groupOrder = 0,
    ): void => {
      nodes.add(object);
      const active = parentVisible && object.visible;
      if (active) activeObjects.add(object);
      const matched = active && object.layers.test(camera.layers);
      const planes = matched ? objectClipping(object, parentClipping) : parentClipping;
      const order = matched && object instanceof Group ? object.renderOrder : groupOrder;
      groupOrders.set(object, order);
      clipping.set(object, planes);
      if (active && object.layers.test(camera.layers)) {
        if (object instanceof LOD && object.autoUpdate) object.update(camera);
        this.validateObject(object);
        nodes.add(object);
        visible.add(object);
      }
      for (const child of object.children) visit(child, active, planes, order);
    };
    visit(scene);
    for (const object of visible) displayVisible.add(object);
    if (buffers.shadowMap?.enabled) {
      const shadowMasks = [...visible]
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
      for (const object of activeObjects) {
        if (
          !isRenderable(object) ||
          !castsShadow(object) ||
          !shadowMasks.some((mask) => (object.layers.mask & mask) !== 0)
        )
          continue;
        this.validateObject(object);
        visible.add(object);
      }
    }
    // Scene owns ambient state even when its own layer does not match the camera.
    nodes.add(scene);
    this.validateObject(camera);
    nodes.add(camera);
    const clippingCandidates = [...visible]
      .filter(isRenderable)
      .filter((object) =>
        (Array.isArray(object.material) ? object.material : [object.material]).some(
          (material) => material?.visible,
        ),
      );
    const { camera: cameraClipping, local: localClipping } = projectClipping(
      clippingCandidates,
      clipping,
    );
    const transforms = new Map<
      Object3D,
      {
        values: number[];
        data: { pos: Float32Array; quat: Float32Array; scale: Float32Array; shear: Float32Array };
      }
    >();
    for (const object of nodes) {
      if (object !== camera && !visible.has(object)) continue;
      const values =
        object === camera
          ? camera.matrixWorldInverse.elements
          : object instanceof Sprite
            ? spriteMatrix(object, camera).elements
            : object.matrixWorld.elements;
      if (sameValues(this.nodes.get(object)?.transform ?? [], values)) continue;
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
      transforms.set(object, {
        values: [...values],
        data: { pos: position, quat: rotation, scale, shear },
      });
    }
    for (const object of nodes) {
      if (!visible.has(object)) continue;
      if (isRenderable(object)) {
        if (
          object.frustumCulled &&
          !(buffers.shadowMap?.enabled && castsShadow(object)) &&
          !(object instanceof Sprite
            ? frustum.intersectsSprite(object)
            : frustum.intersectsObject(object))
        )
          continue;
        const grouped = Array.isArray(object.material);
        const sourceList = grouped
          ? (object.material as Material[])
          : [object.material as Material];
        const selection: GeometryMaterial[] = [];
        const list: MaterialUse[] = [];
        const coordinates = new Map<Texture, ResolvedMaterialTextureCoordinates>();
        let topology: 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' =
          object instanceof Points
            ? 'point-list'
            : object instanceof LineSegments
              ? 'line-list'
              : object instanceof Line
                ? 'line-strip'
                : 'triangle-list';
        const primitiveSize =
          topology === 'triangle-list'
            ? 3
            : topology === 'line-list' || topology === 'line-strip'
              ? 2
              : 1;
        const available =
          object.geometry.index?.count ?? object.geometry.getAttribute('position')?.count ?? 0;
        const ranges = grouped
          ? object.geometry.groups
          : [{ materialIndex: 0, start: 0, count: available }];
        for (const range of ranges) {
          const first = Math.max(0, range.start, object.geometry.drawRange.start);
          const last = Math.min(
            available,
            range.start + range.count,
            object.geometry.drawRange.start + object.geometry.drawRange.count,
          );
          if (last - first < primitiveSize) continue;
          const slot = range.materialIndex ?? 0;
          const original = sourceList[slot];
          if (
            original === undefined ||
            !original.visible ||
            selection.some((item) => item.slot === slot)
          )
            continue;
          const material =
            scene instanceof Scene && original.allowOverride
              ? (scene.overrideMaterial ?? original)
              : original;
          // r184 inherits alpha coverage and transparency from each source draw when overriding.
          const effective: Material = Object.assign(
            Object.create(material),
            material === original
              ? {}
              : {
                  alphaTest: original.alphaTest,
                  alphaMap: 'alphaMap' in original ? original.alphaMap : null,
                  transparent:
                    original.transparent ||
                    ('transmission' in original && Number(original.transmission) > 0),
                },
            buffers.depth ? {} : { depthTest: false, depthWrite: false },
            buffers.stencil ? {} : { stencilWrite: false },
          );
          const source = validateMaterial(effective).unwrap();
          const blended =
            source.transparent || ('transmission' in source && Number(source.transmission) > 0);
          if (blended ? !buffers.transparent : !buffers.opaque) continue;
          const planes = localClipping.get(object);
          const shading = Number(usesFlatShading(source, object.geometry.hasAttribute('normal'))) as
            | 0
            | 1;
          const use: MaterialUse = {
            source: material,
            effective: source,
            shading,
            skinned: object instanceof SkinnedMesh && source instanceof MeshBasicMaterial,
            shadowOnly: !displayVisible.has(object),
            coordinates,
            variant: JSON.stringify([
              material === original ? '' : original.uuid,
              planes,
              object instanceof SkinnedMesh,
              !displayVisible.has(object),
            ]),
            ...(planes === undefined ? {} : { clipping: planes }),
          };
          selection.push({ slot, vertexColors: source.vertexColors });
          list.push(use);
        }
        if (list.length === 0) continue;
        const cpuSkin = object instanceof SkinnedMesh && list.some((use) => !use.skinned);
        if (cpuSkin) for (const use of list) Object.assign(use, { skinned: false });
        const wireframe = list.some(
          (use) => 'wireframe' in use.effective && use.effective.wireframe,
        );
        if (
          wireframe &&
          list.some((use) => !('wireframe' in use.effective) || !use.effective.wireframe)
        )
          unsupported(
            'Mixed solid/wireframe groups require native per-submesh line expansion',
            object.uuid,
          ).unwrap();
        if (wireframe) topology = 'line-list';
        if (
          (object.renderOrder !== 0 || (groupOrders.get(object) ?? 0) !== 0) &&
          list.some((use) => !use.effective.transparent)
        )
          unsupported(
            'Opaque renderOrder requires native ordered opaque draws',
            object.uuid,
          ).unwrap();
        const uv = projectUvs(
          object.geometry,
          list.flatMap((use) =>
            use.effective instanceof MeshMatcapMaterial
              ? []
              : materialTextures(use.effective).map(([, texture]) => texture),
          ),
        );
        const flatMatcap = new Set(
          list.flatMap((use, slot) =>
            use.effective instanceof MeshMatcapMaterial && use.shading === 1 ? [slot] : [],
          ),
        );
        for (const [texture, value] of uv.coordinates) coordinates.set(texture, value);
        const expanded =
          object instanceof BatchedMesh ||
          (object instanceof InstancedMesh &&
            (object.instanceColor !== null || object.morphTexture !== null));
        const variant = JSON.stringify([
          topology,
          grouped,
          selection,
          expanded || cpuSkin || flatMatcap.size > 0 ? object.uuid : '',
          wireframe,
          uv.values,
          [...flatMatcap],
        ]);
        const values = geometryValues(object.geometry, grouped);
        if (cpuSkin) values.push(...cpuSkinValues(object as SkinnedMesh));
        if (flatMatcap.size > 0 && object instanceof Mesh)
          values.push(...(object.morphTargetInfluences ?? []));
        const firstMaterial = list[0]?.effective;
        if (expanded && firstMaterial !== undefined)
          values.push(
            ...instanceGeometryValues(object as InstancedMesh | BatchedMesh, camera, firstMaterial),
          );
        const payload =
          this.geometry.read(object.geometry, values, variant)?.payload ??
          (() => {
            let base = projectGeometry(
              object.geometry,
              grouped,
              selection,
              topology,
              uv.attributes,
              wireframe,
            ).unwrap();
            if (base !== undefined && cpuSkin) base = projectCpuSkin(object as SkinnedMesh, base);
            if (base !== undefined && expanded)
              base = projectInstanceGeometry(object as InstancedMesh | BatchedMesh, base);
            if (base !== undefined && flatMatcap.size > 0) {
              base = projectFlatNormals(
                base,
                flatMatcap,
                object instanceof Mesh ? object.morphTargetInfluences : undefined,
              );
            }
            return base;
          })();
        if (payload === undefined) continue;
        for (const use of list) {
          const source = use.effective;
          if (use.clipping !== undefined && (object instanceof Line || object instanceof Points))
            unsupported('Native Lines/Points support camera clipping only', object.uuid).unwrap();
          if (clipping.get(object) !== undefined && source.alphaToCoverage)
            unsupported(
              'ClippingGroup alphaToCoverage requires native smooth clipping coverage',
              object.uuid,
            ).unwrap();
          if (object instanceof Line || object instanceof Points) {
            if (!(source instanceof LineBasicMaterial || source instanceof PointsMaterial))
              unsupported('Lines/Points require their unlit material family', object.uuid).unwrap();
            if (source.vertexColors && object.geometry.hasAttribute('color'))
              unsupported(
                'Native Lines/Points do not transport per-vertex colors',
                object.uuid,
              ).unwrap();
            if (materialTextures(source).length > 0)
              unsupported(
                'Native Lines/Points do not transport source UV or point coordinates',
                object.uuid,
              ).unwrap();
          }
          if (source instanceof MeshNormalMaterial && !object.geometry.hasAttribute('normal'))
            return unsupported(
              'Normal/Matcap without normals requires flat shading',
              object.uuid,
            ).unwrap();
          usedMaterials[use.shading].add(use);
          const orientation = source instanceof MeshMatcapMaterial ? 1 : 0;
          for (const [, texture] of materialTextures(source)) {
            if (texturePlans[orientation].has(texture)) continue;
            if (isExternalTexture(texture)) continue;
            validateTexture(texture).unwrap();
            if (
              orientation === 1 &&
              texture.matrix.elements.some((value, index) => value !== (index % 4 === 0 ? 1 : 0))
            )
              unsupported('Matcap Texture UV transform', texture.uuid).unwrap();
            const values = textureValues(texture),
              samplerSignature = samplerValues(texture);
            texturePlans[orientation].set(texture, {
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
                this.samplers.read(texture, samplerSignature)?.payload ??
                projectSampler(texture).unwrap(),
            });
          }
        }
        const lines =
          object instanceof Line
            ? lineStyle(
                object,
                payload,
                list.map((use) => use.effective),
              )
            : wireframe
              ? { dashSize: 1, gapSize: 0, dashOffset: 0 }
              : undefined;
        if (lines === null) continue;
        let instanceValues: readonly unknown[] | undefined;
        let instances: Float32Array | undefined;
        if (object instanceof InstancedMesh) {
          if (
            !Number.isInteger(object.count) ||
            object.count < 0 ||
            object.count > object.instanceMatrix.count
          )
            invalid('InstancedMesh.count', object.uuid).unwrap();
          instanceValues = [
            object.instanceMatrix,
            object.instanceMatrix.array,
            object.instanceMatrix.version,
            object.count,
            expanded,
          ];
          if (!expanded && !sameValues(this.nodes.get(object)?.instances ?? [], instanceValues)) {
            instances = new Float32Array(object.instanceMatrix.array.slice(0, object.count * 16));
            for (let offset = 0; offset < instances.length; offset += 16) {
              const matrix = instances.subarray(offset, offset + 16);
              if (
                !mat4.decomposeAffine(
                  vec3.create(),
                  quat.create(),
                  vec3.create(),
                  vec3.create(),
                  matrix,
                )
              )
                invalid('InstancedMesh.instanceMatrix', object.uuid).unwrap();
            }
          }
          if (object.count === 0) continue;
        }
        let skin: MeshPlan['skin'];
        if (object instanceof SkinnedMesh && !cpuSkin) {
          const values = skinValues(object),
            variant = JSON.stringify(object.bindMatrix.elements);
          const skeleton =
            this.skeletons.read(object.skeleton, values, variant) ??
            this.skeletons.write(object.skeleton, values, projectSkeleton(object), variant);
          if (
            payload.attributes.skinIndex === undefined ||
            payload.attributes.skinWeight === undefined
          )
            invalid('SkinnedMesh skinIndex/skinWeight', object.uuid).unwrap();
          if (
            payload.attributes.skinIndex instanceof Uint16Array &&
            payload.attributes.skinIndex.some((joint) => joint >= object.skeleton.bones.length)
          )
            invalid('SkinnedMesh joint index', object.uuid).unwrap();
          skin = { skeleton: skeleton.handle, joints: projectJoints(object) };
        }
        const morphWeights =
          payload.morphTargets === undefined
            ? undefined
            : new Float32Array(
                object instanceof Mesh
                  ? (object.morphTargetInfluences ??
                      (object instanceof InstancedMesh
                        ? Array.from({ length: payload.morphTargets.length }, () => 0)
                        : []))
                  : [],
              );
        if (
          morphWeights !== undefined &&
          (morphWeights.length !== payload.morphTargets?.length ||
            !morphWeights.every(Number.isFinite))
        )
          invalid('Mesh.morphTargetInfluences', object.uuid).unwrap();
        meshes.set(object, {
          source: object,
          variant,
          materials: list,
          values,
          payload,
          nativeInstances: object instanceof InstancedMesh && !expanded,
          ...(instanceValues === undefined ? {} : { instanceValues }),
          ...(instances === undefined ? {} : { instances }),
          ...(morphWeights === undefined ? {} : { morphWeights }),
          ...(skin === undefined ? {} : { skin }),
          ...(lines === undefined ? {} : { lineStyle: lines }),
        });
      }
    }
    const ambientIrradiance: [number, number, number] = [0, 0, 0];
    for (const object of visible) {
      if (!(object instanceof AmbientLight)) continue;
      ambientIrradiance[0] = ambientIrradiance[0] + object.color.r * object.intensity;
      ambientIrradiance[1] = ambientIrradiance[1] + object.color.g * object.intensity;
      ambientIrradiance[2] = ambientIrradiance[2] + object.color.b * object.intensity;
    }
    if (!ambientIrradiance.every((value) => Number.isFinite(Math.fround(value))))
      invalid('AmbientLight total irradiance', scene.uuid).unwrap();
    // New resource leases stay provisional until all material preparation succeeds.
    const textureBindings = [
      new Map<Texture, MaterialTextureValue>(),
      new Map<Texture, MaterialTextureValue>(),
    ] as const;
    for (const orientation of [0, 1] as const) {
      for (const plan of texturePlans[orientation].values()) {
        const previous = this.textures[orientation].read(plan.source, plan.values);
        const texture =
          previous ?? this.textures[orientation].write(plan.source, plan.values, plan.payload);
        if (previous === undefined) uploaded(plan.source);
        const sampler =
          this.samplers.read(plan.source, plan.samplerValues) ??
          this.samplers.write(plan.source, plan.samplerValues, plan.sampler);
        textureBindings[orientation].set(plan.source, {
          texture: texture.handle,
          sampler: sampler.handle,
        });
      }
    }
    const materialHandles = [
      new Map<MaterialUse, AssetHandle<'material'>>(),
      new Map<MaterialUse, AssetHandle<'material'>>(),
    ] as const;
    for (const shading of [0, 1] as const) {
      for (const use of usedMaterials[shading]) {
        const source = use.effective;
        const bindings: Record<string, MaterialTextureValue> = {};
        const values = [...materialValues(source), varianceShadow];
        for (const [parameter, texture] of materialTextures(source)) {
          const binding = isExternalTexture(texture)
            ? ({
                ...(this.external?.binding(texture) ??
                  unsupported(
                    'External texture requires a renderer import lease',
                    texture.uuid,
                  ).unwrap()),
                sampler: (
                  this.samplers.read(texture, samplerValues(texture)) ??
                  this.samplers.write(
                    texture,
                    samplerValues(texture),
                    projectSampler(texture).unwrap(),
                  )
                ).handle,
                coordinates: use.coordinates.get(texture),
              } as MaterialTextureValue)
            : textureBindings[source instanceof MeshMatcapMaterial ? 1 : 0].get(texture);
          if (binding === undefined)
            throw new Error('admitted texture missing its managed asset reference');
          const coordinates = use.coordinates.get(texture);
          bindings[parameter] = {
            ...binding,
            ...(coordinates === undefined ? {} : { coordinates }),
          };
          values.push(
            parameter,
            binding.texture ?? binding.source,
            binding.sampler,
            coordinates?.set ?? 0,
            ...(coordinates?.transform?.offset ?? [0, 0]),
            ...(coordinates?.transform?.scale ?? [1, 1]),
            coordinates?.transform?.rotation ?? 0,
          );
        }
        const entry =
          this.materials[shading].read(use.source, values, use.variant) ??
          this.materials[shading].write(
            use.source,
            values,
            (() => {
              let projected = projectMaterial(
                source,
                bindings,
                shading === 1,
                varianceShadow,
              ).unwrap();
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
            })(),
            use.variant,
          );
        materialHandles[shading].set(use, entry.handle);
      }
    }
    const geometryHandles = new Map<Renderable, AssetHandle<'mesh'>>();
    for (const plan of meshes.values()) {
      const cache = this.geometry;
      const entry =
        cache.read(plan.source.geometry, plan.values, plan.variant) ??
        cache.write(plan.source.geometry, plan.values, plan.payload, plan.variant);
      geometryHandles.set(plan.source, entry.handle);
    }
    // Native layers express the source transparent order even when camera depth
    // differs from world Z. Opaque ordering remains a separate native contract.
    const transparent = [...meshes.values()].filter((plan) =>
      plan.materials.some(
        (use) =>
          use.effective.transparent ||
          ('transmission' in use.effective && Number(use.effective.transmission) > 0),
      ),
    );
    const sourceDepth = (plan: MeshPlan) => {
      if (plan.source instanceof Sprite)
        return new Vector3()
          .setFromMatrixPosition(plan.source.matrixWorld)
          .applyMatrix4(camera.matrixWorldInverse).z;
      const geometry = plan.source.geometry;
      if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
      return (geometry.boundingSphere?.center.clone() ?? new Vector3())
        .applyMatrix4(plan.source.matrixWorld)
        .applyMatrix4(camera.matrixWorldInverse).z;
    };
    const depths = new Map(transparent.map((plan) => [plan, sourceDepth(plan)]));
    if (buffers.sortObjects)
      transparent.sort(
        (a, b) =>
          (groupOrders.get(a.source) ?? 0) - (groupOrders.get(b.source) ?? 0) ||
          a.source.renderOrder - b.source.renderOrder ||
          (depths.get(a) ?? 0) - (depths.get(b) ?? 0) ||
          a.source.id - b.source.id,
      );
    const transparentRanks = new Map(transparent.map((plan, rank) => [plan.source, rank]));
    return () => {
      for (const object of nodes) {
        if (this.nodes.has(object)) continue;
        const entity = this.world
          .spawn(
            { component: Transform, data: {} },
            { component: Name, data: { value: object.name } },
          )
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
        if (isRenderable(object)) {
          this.world.addComponent(entity, { component: MeshFilter, data: {} }).unwrap();
          if (object instanceof InstancedMesh)
            this.world.addComponent(entity, { component: Instances, data: {} }).unwrap();
          if (object instanceof Line)
            this.world
              .addComponent(entity, { component: NativeLines, data: { width: 1 } })
              .unwrap();
          if (object instanceof Points)
            this.world
              .addComponent(entity, { component: NativePoints, data: { sizePx: 1 } })
              .unwrap();
          this.world.addComponent(entity, { component: MeshRenderer, data: {} }).unwrap();
          this.world
            .addComponent(entity, {
              component: ShadowParticipation,
              data: { cast: false, receive: false },
            })
            .unwrap();
        }
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
      const sceneEntity = this.nodes.get(scene)?.entity;
      if (sceneEntity === undefined) throw new Error('admitted scene missing its entity');
      if (!this.world.hasComponent(sceneEntity, Skylight))
        this.world
          .addComponent(sceneEntity, { component: Skylight, data: { intensity: 0 } })
          .unwrap();
      this.write(sceneEntity, Skylight, {
        ambientIrradiance,
        equirect: lighting,
        intensity: lighting !== 0 && scene instanceof Scene ? scene.environmentIntensity : 0,
        rotation: lightingRotation,
      });
      if (background !== 0) {
        if (!this.world.hasComponent(sceneEntity, SkyboxBackground))
          this.world.addComponent(sceneEntity, { component: SkyboxBackground, data: {} }).unwrap();
        this.write(sceneEntity, SkyboxBackground, {
          equirect: background,
          rotation: backgroundRotation,
        });
      } else if (this.world.hasComponent(sceneEntity, SkyboxBackground))
        this.world.removeComponent(sceneEntity, SkyboxBackground).unwrap();
      for (const [object, record] of this.nodes) {
        if (!nodes.has(object)) {
          record.disposeSource?.();
          for (const joint of record.joints ?? []) this.world.despawn(joint).unwrap();
          this.world.despawn(record.entity).unwrap();
          this.nodes.delete(object);
          continue;
        }
        const transform = transforms.get(object);
        if (transform !== undefined) {
          this.write(record.entity, Transform, transform.data);
          record.transform = transform.values;
        }
        this.write(record.entity, Name, { value: object.name });
        if (isRenderable(object)) {
          this.write(record.entity, ShadowParticipation, {
            channels: object.layers.mask >>> 0,
            cast: castsShadow(object),
            receive: object.receiveShadow,
          });
          if (!meshes.has(object)) {
            this.write(record.entity, MeshFilter, { assetHandle: 0 as AssetHandle<'mesh'> });
            this.write(record.entity, MeshRenderer, { materials: [] });
          }
        }
      }
      for (const [object, record] of this.nodes) {
        if (!visible.has(object)) {
          if (object instanceof DirectionalLight)
            this.write(record.entity, NativeDirectionalLight, { intensity: 0 });
          if (object instanceof SpotLight)
            this.write(record.entity, NativeSpotLight, { intensity: 0 });
          if (object instanceof PointLight)
            this.write(record.entity, NativePointLight, { intensity: 0 });
          if (object instanceof RectAreaLight)
            this.write(record.entity, NativeRectAreaLight, { intensity: 0 });
          continue;
        }
        if (object instanceof DirectionalLight || object instanceof SpotLight) {
          const direction = new Vector3()
            .setFromMatrixPosition(object.target.matrixWorld)
            .sub(new Vector3().setFromMatrixPosition(object.matrixWorld))
            .normalize();
          const hasDirection = direction.lengthSq() > 0;
          if (!hasDirection) direction.set(0, -1, 0);
          const light = {
            direction: direction.toArray(),
            color: object.color.toArray(),
            intensity: visible.has(object) && hasDirection ? object.intensity : 0,
          };
          if (object instanceof SpotLight)
            this.write(record.entity, NativeSpotLight, {
              ...light,
              ...(this.shadowUpdates.project(object, buffers.shadowMap) ?? { castShadow: false }),
              range: object.distance === 0 ? Infinity : object.distance,
              outerConeDeg: (object.angle * 180) / Math.PI,
              innerConeDeg: (object.angle * (1 - object.penumbra) * 180) / Math.PI,
            });
          else
            this.write(record.entity, NativeDirectionalLight, {
              ...light,
              ...(this.shadowUpdates.project(object, buffers.shadowMap) ?? { castShadow: false }),
            });
        }
        if (object instanceof RectAreaLight)
          this.write(record.entity, NativeRectAreaLight, {
            color: object.color.toArray(),
            intensity: visible.has(object) ? object.intensity : 0,
            width: object.width,
            height: object.height,
          });
        if (object instanceof PointLight) {
          const shadow = this.shadowUpdates.project(object, buffers.shadowMap);
          if (shadow !== undefined) {
            if (!this.world.hasComponent(record.entity, NativePointLightShadow))
              this.world
                .addComponent(record.entity, { component: NativePointLightShadow, data: shadow })
                .unwrap();
            else this.write(record.entity, NativePointLightShadow, shadow);
          } else if (this.world.hasComponent(record.entity, NativePointLightShadow)) {
            this.world.removeComponent(record.entity, NativePointLightShadow).unwrap();
          }
          this.write(record.entity, NativePointLight, {
            color: object.color.toArray(),
            intensity: visible.has(object) ? object.intensity : 0,
            range: object.distance === 0 ? Infinity : object.distance,
            decay: object.decay,
          });
        }
      }
      for (const plan of meshes.values()) {
        const handle = geometryHandles.get(plan.source);
        if (handle === undefined)
          throw new Error('admitted geometry missing its managed asset reference');
        const entity = this.nodes.get(plan.source)?.entity;
        if (entity === undefined) throw new Error('admitted mesh missing its entity');
        const list = plan.materials;
        this.write(entity, MeshFilter, { assetHandle: handle });
        if (!this.world.hasComponent(entity, Layer))
          this.world.addComponent(entity, { component: Layer, data: {} }).unwrap();
        this.write(entity, Layer, { value: transparentRanks.get(plan.source) ?? 0 });
        if (plan.lineStyle !== undefined) {
          if (!this.world.hasComponent(entity, NativeLines))
            this.world
              .addComponent(entity, { component: NativeLines, data: { width: 1 } })
              .unwrap();
          this.write(entity, NativeLines, plan.lineStyle);
        } else if (!(plan.source instanceof Line) && this.world.hasComponent(entity, NativeLines))
          this.world.removeComponent(entity, NativeLines).unwrap();
        if (plan.nativeInstances) {
          if (!this.world.hasComponent(entity, Instances))
            this.world.addComponent(entity, { component: Instances, data: {} }).unwrap();
          if (plan.instances !== undefined)
            this.write(entity, Instances, { transforms: plan.instances });
        } else if (this.world.hasComponent(entity, Instances))
          this.world.removeComponent(entity, Instances).unwrap();
        const record = this.nodes.get(plan.source);
        if (record !== undefined && plan.instanceValues !== undefined)
          record.instances = plan.instanceValues;
        if (plan.skin !== undefined && record !== undefined) {
          const joints = record.joints ?? [];
          while (joints.length > plan.skin.joints.length)
            this.world.despawn(joints.pop() as EntityHandle).unwrap();
          while (joints.length < plan.skin.joints.length)
            joints.push(this.world.spawn({ component: Transform, data: {} }).unwrap());
          record.joints = joints;
          for (let index = 0; index < joints.length; index++) {
            const joint = joints[index],
              data = plan.skin.joints[index];
            if (joint !== undefined && data !== undefined) this.write(joint, Transform, data);
          }
          if (!this.world.hasComponent(entity, Skin))
            this.world.addComponent(entity, { component: Skin, data: {} }).unwrap();
          this.write(entity, Skin, { skeleton: plan.skin.skeleton, joints });
        } else if (this.world.hasComponent(entity, Skin)) {
          this.world.removeComponent(entity, Skin).unwrap();
          for (const joint of record?.joints ?? []) this.world.despawn(joint).unwrap();
          if (record !== undefined) record.joints = [];
        }
        if (plan.morphWeights !== undefined) {
          if (!this.world.hasComponent(entity, MorphWeights))
            this.world.addComponent(entity, { component: MorphWeights, data: {} }).unwrap();
          this.write(entity, MorphWeights, { weights: plan.morphWeights });
        } else if (this.world.hasComponent(entity, MorphWeights))
          this.world.removeComponent(entity, MorphWeights).unwrap();
        this.write(entity, MeshRenderer, {
          materials: list.map((use) => {
            const handle = materialHandles[use.shading].get(use);
            if (handle === undefined)
              throw new Error('admitted material missing its managed asset reference');
            return handle;
          }),
        });
      }
      const cameraEntity = this.nodes.get(camera)?.entity;
      if (cameraEntity === undefined) throw new Error('admitted camera missing its entity');
      this.write(cameraEntity, NativeCamera, cameraData);
      if (cameraClipping !== undefined) {
        if (!this.world.hasComponent(cameraEntity, ClippingPlanes))
          this.world.addComponent(cameraEntity, { component: ClippingPlanes, data: {} }).unwrap();
        this.write(cameraEntity, ClippingPlanes, clippingPlanesData(cameraClipping));
      } else if (this.world.hasComponent(cameraEntity, ClippingPlanes))
        this.world.removeComponent(cameraEntity, ClippingPlanes).unwrap();
      propagateTransforms(this.world).unwrap();
      for (const texture of uploadedTextures) this.textureUpdates.add(texture);
      return cameraEntity;
    };
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
    for (const record of this.nodes.values()) {
      record.disposeSource?.();
      for (const joint of record.joints ?? []) this.world.despawn(joint).unwrap();
      this.world.despawn(record.entity).unwrap();
    }
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
