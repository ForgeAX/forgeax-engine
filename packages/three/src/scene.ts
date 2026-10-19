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
  MeshFilter,
  MeshRenderer,
  Camera as NativeCamera,
  DirectionalLight as NativeDirectionalLight,
  PointLight as NativePointLight,
  SpotLight as NativeSpotLight,
  ShadowParticipation,
  Skylight,
} from '@forgeax/engine-render';
import { Name, propagateTransforms, Transform } from '@forgeax/engine-scene';
import {
  type Handle,
  type MaterialAsset,
  type MaterialTextureValue,
  type MeshAsset,
  type SamplerAsset,
  type TextureAsset,
  toShared,
} from '@forgeax/engine-types';
import {
  AmbientLight,
  type BufferGeometry,
  Camera,
  Color,
  DirectionalLight,
  type Material,
  Mesh,
  MeshMatcapMaterial,
  Object3D,
  PointLight,
  Scene,
  SpotLight,
  type Texture,
  Vector3,
} from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';
import { geometryValues, projectGeometry } from './geometry';
import { materialTextures, materialValues, projectMaterial, validateMaterial } from './material';
import { SharedAssets, sameValues } from './shared-assets';
import {
  projectSampler,
  projectTexture,
  samplerValues,
  textureValues,
  validateTexture,
} from './texture';

interface NodeRecord {
  readonly entity: EntityHandle;
  transform: readonly number[];
}
interface MeshPlan {
  readonly source: Mesh;
  readonly grouped: boolean;
  readonly values: unknown[];
  readonly payload: MeshAsset;
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

/** Cached source world matrices author flat native affine transforms; Scene derives the GPU-facing matrices. */
export class SceneProjection {
  constructor(
    private readonly prepareMaterial: (material: MaterialAsset) => MaterialAsset = (material) =>
      material,
  ) {}

  readonly world = new World();
  private readonly nodes = new Map<Object3D, NodeRecord>();
  private readonly geometry = [
    new SharedAssets<BufferGeometry, MeshAsset>(this.world, 'MeshAsset'),
    new SharedAssets<BufferGeometry, MeshAsset>(this.world, 'MeshAsset'),
  ] as const;
  private readonly materials = new SharedAssets<Material, MaterialAsset>(
    this.world,
    'MaterialAsset',
  );
  // Native matcap coordinates already invert V. Keep its image projection separate
  // when the same Three texture is also used in an ordinary UV slot.
  private readonly textures = [
    new SharedAssets<Texture, TextureAsset>(this.world, 'TextureAsset'),
    new SharedAssets<Texture, TextureAsset>(this.world, 'TextureAsset'),
  ] as const;
  private readonly samplers = new SharedAssets<Texture, SamplerAsset>(this.world, 'SamplerAsset');

  sync(
    scene: Object3D,
    camera: Camera,
    cameraData: CameraData,
    output: readonly [number, number, number, number] = [0, 1, 1, 0],
  ): EntityHandle {
    const caches = [...this.geometry, this.materials, ...this.textures, this.samplers];
    for (const cache of caches) cache.begin();
    try {
      const entity = this.project(scene, camera, cameraData, output);
      for (const cache of caches) cache.commit();
      return entity;
    } catch (error) {
      for (const cache of caches) cache.abort();
      throw error;
    }
  }

  private project(
    scene: Object3D,
    camera: Camera,
    cameraData: CameraData,
    output: readonly [number, number, number, number],
  ): EntityHandle {
    if (
      scene instanceof Scene &&
      ((scene.background !== null && !(scene.background instanceof Color)) ||
        scene.environment !== null ||
        scene.fog !== null ||
        scene.overrideMaterial !== null)
    )
      return unsupported('Scene background/environment/fog/overrideMaterial', scene.uuid).unwrap();
    if (
      scene.onBeforeRender !== Object3D.prototype.onBeforeRender ||
      scene.onAfterRender !== Object3D.prototype.onAfterRender
    )
      return unsupported('Scene render callbacks', scene.uuid).unwrap();
    const nodes = new Set<Object3D>();
    const visible = new Set<Object3D>();
    const meshes = new Map<Mesh, MeshPlan>();
    const texturePlans = [
      new Map<Texture, TexturePlan>(),
      new Map<Texture, TexturePlan>(),
    ] as const;
    const usedMaterials = new Set<Material>();
    const visit = (object: Object3D, parentVisible: boolean): void => {
      this.validateObject(object);
      nodes.add(object);
      const isVisible = parentVisible && object.visible;
      if (isVisible && object.layers.test(camera.layers)) visible.add(object);
      for (const child of object.children) visit(child, isVisible);
    };
    visit(scene, true);
    this.validateObject(camera);
    nodes.add(camera);
    // Match upstream's cache update boundary, including frozen matrices and cameras
    // whose parent lives outside the submitted root. Do not walk/update external parents.
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
    const transforms = new Map<
      Object3D,
      {
        values: number[];
        data: { pos: Float32Array; quat: Float32Array; scale: Float32Array; shear: Float32Array };
      }
    >();
    for (const object of nodes) {
      const values =
        object === camera ? camera.matrixWorldInverse.elements : object.matrixWorld.elements;
      if (sameValues(this.nodes.get(object)?.transform ?? [], values)) continue;
      // r184 removes camera scale when updating its view cache; manual view edits
      // and frozen inverses remain independent of the source world matrix.
      const matrix =
        object === camera ? camera.matrixWorldInverse.clone().invert().elements : values;
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
      if (object instanceof Mesh) {
        const list = Array.isArray(object.material) ? object.material : [object.material];
        if (list.length === 0 || list.every((material) => !material.visible)) continue;
        if (list.some((material) => !material.visible))
          return unsupported('mixed visible/invisible material array', object.uuid).unwrap();
        const grouped = Array.isArray(object.material);
        const values = geometryValues(object.geometry, grouped);
        const payload =
          this.geometry[Number(grouped) as 0 | 1].read(object.geometry, values)?.payload ??
          projectGeometry(object.geometry, grouped).unwrap();
        if (payload === undefined) continue;
        if (payload.submeshes.some((submesh) => list[submesh.materialSlot] === undefined))
          return invalid('Mesh.material missing group slot', object.uuid).unwrap();
        for (const material of list) {
          const source = validateMaterial(material).unwrap();
          if (source.vertexColors !== (payload.attributes.color !== undefined))
            return unsupported(
              'vertex colors require both geometry color and material.vertexColors',
              object.uuid,
            ).unwrap();
          usedMaterials.add(source);
          const orientation = source instanceof MeshMatcapMaterial ? 1 : 0;
          for (const [, texture] of materialTextures(source)) {
            if (texturePlans[orientation].has(texture)) continue;
            validateTexture(texture).unwrap();
            const values = textureValues(texture),
              samplerSignature = samplerValues(texture);
            texturePlans[orientation].set(texture, {
              source: texture,
              values,
              samplerValues: samplerSignature,
              payload:
                this.textures[orientation].read(texture, values)?.payload ??
                projectTexture(
                  texture,
                  orientation === 1 ? !texture.flipY : texture.flipY,
                ).unwrap(),
              sampler:
                this.samplers.read(texture, samplerSignature)?.payload ??
                projectSampler(texture).unwrap(),
            });
          }
        }
        meshes.set(object, { source: object, grouped, values, payload });
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
        const texture =
          this.textures[orientation].read(plan.source, plan.values) ??
          this.textures[orientation].write(plan.source, plan.values, plan.payload);
        const sampler =
          this.samplers.read(plan.source, plan.samplerValues) ??
          this.samplers.write(plan.source, plan.samplerValues, plan.sampler);
        textureBindings[orientation].set(plan.source, {
          texture: texture.handle,
          sampler: sampler.handle,
        });
      }
    }
    const materialHandles = new Map<Material, Handle<'MaterialAsset', 'shared'>>();
    for (const material of usedMaterials) {
      const source = validateMaterial(material).unwrap();
      const bindings: Record<string, MaterialTextureValue> = {};
      const values = [...materialValues(source), ...output];
      for (const [parameter, texture] of materialTextures(source)) {
        const binding = textureBindings[source instanceof MeshMatcapMaterial ? 1 : 0].get(texture);
        if (binding === undefined) throw new Error('admitted texture missing its World reference');
        bindings[parameter] = binding;
        values.push(parameter, binding.texture, binding.sampler);
      }
      const entry =
        this.materials.read(source, values) ??
        this.materials.write(
          source,
          values,
          this.prepareMaterial(projectMaterial(source, bindings, output).unwrap()),
        );
      materialHandles.set(source, entry.handle);
    }
    for (const object of nodes) {
      if (this.nodes.has(object)) continue;
      const entity = this.world
        .spawn(
          { component: Transform, data: {} },
          { component: Name, data: { value: object.name } },
        )
        .unwrap();
      this.nodes.set(object, { entity, transform: [] });
      if (object instanceof Camera)
        this.world.addComponent(entity, { component: NativeCamera, data: {} }).unwrap();
      if (object instanceof Mesh) {
        this.world.addComponent(entity, { component: MeshFilter, data: {} }).unwrap();
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
    this.write(sceneEntity, Skylight, { ambientIrradiance });
    for (const [object, record] of this.nodes) {
      if (!nodes.has(object)) {
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
      if (object instanceof Mesh && !meshes.has(object)) {
        this.write(record.entity, MeshFilter, { assetHandle: toShared<'MeshAsset'>(0) });
        this.write(record.entity, MeshRenderer, { materials: [] });
      }
    }
    for (const [object, record] of this.nodes) {
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
            range: object.distance === 0 ? Infinity : object.distance,
            outerConeDeg: (object.angle * 180) / Math.PI,
            innerConeDeg: (object.angle * (1 - object.penumbra) * 180) / Math.PI,
          });
        else this.write(record.entity, NativeDirectionalLight, light);
      }
      if (object instanceof PointLight)
        this.write(record.entity, NativePointLight, {
          color: object.color.toArray(),
          intensity: visible.has(object) ? object.intensity : 0,
          range: object.distance === 0 ? Infinity : object.distance,
          decay: object.decay,
        });
    }
    for (const plan of meshes.values()) {
      const cache = this.geometry[Number(plan.grouped) as 0 | 1];
      const entry =
        cache.read(plan.source.geometry, plan.values) ??
        cache.write(plan.source.geometry, plan.values, plan.payload);
      const entity = this.nodes.get(plan.source)?.entity;
      if (entity === undefined) throw new Error('admitted mesh missing its entity');
      const list = Array.isArray(plan.source.material)
        ? plan.source.material
        : [plan.source.material];
      this.write(entity, MeshFilter, { assetHandle: entry.handle });
      this.write(entity, MeshRenderer, {
        materials: list.map((material) => {
          const handle = materialHandles.get(material);
          if (handle === undefined)
            throw new Error('admitted material missing its World reference');
          return handle;
        }),
      });
    }
    const cameraEntity = this.nodes.get(camera)?.entity;
    if (cameraEntity === undefined) throw new Error('admitted camera missing its entity');
    this.write(cameraEntity, NativeCamera, cameraData);
    propagateTransforms(this.world).unwrap();
    return cameraEntity;
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
    for (const record of this.nodes.values()) this.world.despawn(record.entity).unwrap();
    this.nodes.clear();
    for (const cache of [...this.geometry, this.materials, ...this.textures, this.samplers])
      cache.dispose();
  }

  private validateObject(object: Object3D): void {
    if (
      ![
        'Scene',
        'Object3D',
        'Group',
        'Mesh',
        'PerspectiveCamera',
        'OrthographicCamera',
        'AmbientLight',
        'DirectionalLight',
        'PointLight',
        'SpotLight',
      ].includes(object.type)
    )
      unsupported(object.type, object.uuid).unwrap();
    if (
      object.renderOrder !== 0 ||
      !object.frustumCulled ||
      object.castShadow ||
      object.receiveShadow ||
      object.onBeforeRender !== Object3D.prototype.onBeforeRender ||
      object.onAfterRender !== Object3D.prototype.onAfterRender
    )
      unsupported('Object3D renderOrder/shadows/render callbacks', object.uuid).unwrap();
    if (
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
