import { RectAreaLightTexturesLib } from 'three/examples/jsm/lights/RectAreaLightTexturesLib.js';
import IESSpotLight from 'three/src/lights/webgpu/IESSpotLight.js';
import ProjectorLight from 'three/src/lights/webgpu/ProjectorLight.js';
import OriginalLineBasicNodeMaterial from 'three/src/materials/nodes/LineBasicNodeMaterial.js';
import OriginalLineDashedNodeMaterial from 'three/src/materials/nodes/LineDashedNodeMaterial.js';
import OriginalBasicNodeMaterial from 'three/src/materials/nodes/MeshBasicNodeMaterial.js';
import OriginalMeshLambertNodeMaterial from 'three/src/materials/nodes/MeshLambertNodeMaterial.js';
import OriginalMeshMatcapNodeMaterial from 'three/src/materials/nodes/MeshMatcapNodeMaterial.js';
import OriginalMeshNormalNodeMaterial from 'three/src/materials/nodes/MeshNormalNodeMaterial.js';
import OriginalPhysicalNodeMaterial from 'three/src/materials/nodes/MeshPhysicalNodeMaterial.js';
import OriginalStandardNodeMaterial from 'three/src/materials/nodes/MeshStandardNodeMaterial.js';
import type OriginalNodeMaterial from 'three/src/materials/nodes/NodeMaterial.js';
import OriginalNodeMaterialInstance from 'three/src/materials/nodes/NodeMaterialInstance.js';
import OriginalPointsNodeMaterial from 'three/src/materials/nodes/PointsNodeMaterial.js';
import OriginalSpriteNodeMaterial from 'three/src/materials/nodes/SpriteNodeMaterial.js';
import OriginalMaterialReferenceNode from 'three/src/nodes/accessors/MaterialReferenceNode.js';
import OriginalReferenceBaseNode from 'three/src/nodes/accessors/ReferenceBaseNode.js';
import OriginalReferenceNode from 'three/src/nodes/accessors/ReferenceNode.js';
import OriginalTextureNode from 'three/src/nodes/accessors/TextureNode.js';
import OriginalUserDataNode from 'three/src/nodes/accessors/UserDataNode.js';
import OriginalUniformNode from 'three/src/nodes/core/UniformNode.js';
import RectAreaLightNode from 'three/src/nodes/lighting/RectAreaLightNode.js';
import OriginalRenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';
import type { Mesh, SkinnedMesh } from 'three/src/Three.Core.js';
import {
  AmbientLight,
  type Camera,
  DirectionalLight,
  HemisphereLight,
  type Material,
  type Object3D,
  PointLight,
  RectAreaLight,
  RenderTarget,
  type Scene,
  SpotLight,
  type Texture,
  type ToneMapping,
} from 'three/src/Three.Core.js';
import { afterAll, expect } from 'vitest';
import { SURFACE_INPUTS } from '../node-inputs';
import { SIZE } from './render.fixture';

let deviceOwner: OriginalRenderer | undefined;
let devicePromise: Promise<GPUDevice> | undefined;

async function referenceDevice(): Promise<GPUDevice> {
  if (devicePromise === undefined) {
    // Let upstream Three qualify its own feature/limit policy once. Its public
    // device parameter borrows that device without sharing renderer/node caches.
    deviceOwner = new OriginalRenderer();
    const owner = deviceOwner;
    devicePromise = owner.init().then(() => {
      expect((owner.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend).toBe(true);
      return (owner.backend as unknown as { device: GPUDevice }).device;
    });
  }
  return devicePromise;
}

afterAll(async () => {
  await devicePromise?.catch(() => undefined);
  deviceOwner?.dispose();
  deviceOwner = undefined;
  devicePromise = undefined;
});

function referenceExtent(options: { width?: number; height?: number }) {
  return { width: options.width ?? SIZE, height: options.height ?? SIZE };
}

/** Independent r187 WebGPU state avoids cross-renderer texture/node caches. */
export async function renderReference(
  scene: Object3D,
  camera: Camera,
  options: {
    width?: number;
    height?: number;
    clearColor?: import('three/src/Three.Core.js').ColorRepresentation;
    clearAlpha?: number;
    opaqueSort?: Parameters<OriginalRenderer['setOpaqueSort']>[0];
    sortObjects?: boolean;
    transparentSort?: Parameters<OriginalRenderer['setTransparentSort']>[0];
    shadowMap?: { enabled: boolean; type: import('three/src/Three.Core.js').ShadowMapType };
    antialias?: boolean;
    toneMapping?: ToneMapping;
    exposure?: number;
    alpha?: boolean;
    stencil?: boolean;
    depth?: boolean;
  } = {},
): Promise<Uint8Array> {
  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
  const original = new OriginalRenderer({
    device: await referenceDevice(),
    stencil: options.stencil ?? false,
    depth: options.depth ?? true,
    alpha: options.alpha ?? true,
    antialias: options.antialias ?? false,
  });
  const reference = scene.clone();
  const sourceObjects: Object3D[] = [],
    copiedObjects: Object3D[] = [];
  scene.traverse((object) => sourceObjects.push(object));
  reference.traverse((object) => copiedObjects.push(object));
  // Preserve the submitted root's cached pose even when its parent is outside
  // this scene. Descendants still update against this copied world matrix.
  reference.matrixWorldAutoUpdate = false;
  const copies = new Map(sourceObjects.map((source, index) => [source, copiedObjects[index]]));
  const resources = new ReferenceResources();
  for (let i = 0; i < sourceObjects.length; i++) {
    const source = sourceObjects[i],
      copy = copiedObjects[i];
    if (source !== undefined && copy !== undefined) {
      copyReferenceState(source, copy, copies);
      resources.copy(source, copy);
    }
  }
  const constructors = {
    AmbientLight,
    DirectionalLight,
    HemisphereLight,
    PointLight,
    SpotLight,
    RectAreaLight,
  };
  const replaceLights = (parent: Object3D) => {
    for (const child of [...parent.children]) {
      const Constructor =
        child.type === 'SpotLight' && 'iesMap' in child
          ? IESSpotLight
          : child.type === 'SpotLight' && 'aspect' in child
            ? ProjectorLight
            : constructors[child.type as keyof typeof constructors];
      if (Constructor !== undefined) {
        parent.remove(child);
        // LightsNode dispatches on constructor identity across the two bundles.
        parent.add(new Constructor().copy(child as never));
      } else replaceLights(child);
    }
  };
  replaceLights(reference);
  const { width, height } = referenceExtent(options);
  const target = new RenderTarget(width, height);
  original.setSize(width, height);
  if (options.clearColor !== undefined || options.clearAlpha !== undefined)
    original.setClearColor(options.clearColor ?? 0, options.clearAlpha ?? 0);
  if (options.sortObjects !== undefined) original.sortObjects = options.sortObjects;
  if (options.opaqueSort !== undefined) original.setOpaqueSort(options.opaqueSort);
  if (options.transparentSort !== undefined) original.setTransparentSort(options.transparentSort);
  if (options.shadowMap !== undefined) Object.assign(original.shadowMap, options.shadowMap);
  if (options.toneMapping !== undefined) original.toneMapping = options.toneMapping;
  if (options.exposure !== undefined) original.toneMappingExposure = options.exposure;
  try {
    await original.init();
    expect((original.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend).toBe(true);
    const device = (original.backend as unknown as { device: GPUDevice }).device;
    device.pushErrorScope('validation');
    original.setOutputRenderTarget(target);
    const referenceCamera = camera.clone();
    referenceCamera.matrixWorldAutoUpdate = false;
    original.render(reference, referenceCamera);
    const pixels = new Uint8Array(
      await original.readRenderTargetPixelsAsync(target, 0, 0, width, height),
    );
    const validation = await device.popErrorScope();
    expect(validation?.message ?? null).toBeNull();
    return pixels;
  } finally {
    target.dispose();
    original.dispose();
    resources.dispose();
  }
}

/** Independent GPU admission must not mutate the native source's CPU inputs. */
function copyReferenceState(
  source: Object3D,
  copy: Object3D,
  copies: ReadonlyMap<Object3D, Object3D | undefined>,
): void {
  // WebGPU can widen indices and pad storage vec3 attributes in place.
  // The independent oracle must never mutate the native source's geometry.
  if ('geometry' in source && 'geometry' in copy) {
    const from = source as Mesh,
      to = copy as Mesh;
    if (from.geometry === to.geometry) to.geometry = from.geometry.clone();
  }
  // SkinningNode's module-global WeakMap keys a Skeleton by frameId.
  // Independent renderers restart at frame 1; sharing the source Skeleton
  // would skip later pose uploads. Give the oracle its own palette and bones.
  if ('isSkinnedMesh' in source) {
    const from = source as SkinnedMesh,
      to = copy as SkinnedMesh;
    to.skeleton = from.skeleton.clone();
    to.skeleton.bones = from.skeleton.bones.map(
      (bone) => (copies.get(bone) ?? bone) as typeof bone,
    );
  }
  if ('isScene' in source) {
    copy.onBeforeRender = source.onBeforeRender;
    copy.onAfterRender = source.onAfterRender;
  }
  if ('isClippingGroup' in source) {
    const from = source as unknown as Record<string, unknown>,
      to = copy as unknown as Record<string, unknown>;
    for (const field of ['clippingPlanes', 'enabled', 'clipIntersection', 'clipShadows'])
      to[field] = from[field];
  }
}

const referenceNodeModels: Readonly<Record<string, new () => Material>> = {
  MeshBasicNodeMaterial: OriginalBasicNodeMaterial,
  MeshStandardNodeMaterial: OriginalStandardNodeMaterial,
  MeshPhysicalNodeMaterial: OriginalPhysicalNodeMaterial,
  LineBasicNodeMaterial: OriginalLineBasicNodeMaterial,
  LineDashedNodeMaterial: OriginalLineDashedNodeMaterial,
  MeshLambertNodeMaterial: OriginalMeshLambertNodeMaterial,
  MeshMatcapNodeMaterial: OriginalMeshMatcapNodeMaterial,
  MeshNormalNodeMaterial: OriginalMeshNormalNodeMaterial,
  PointsNodeMaterial: OriginalPointsNodeMaterial,
  SpriteNodeMaterial: OriginalSpriteNodeMaterial,
};

/** Reference-only ownership prevents upload callbacks and mutable material caches from leaking into the native source. */
function referenceMaterial(value: Material): Material {
  // Source NodeMaterial methods use the independent upstream TSL constructor family.
  const Type = referenceNodeModels[value.type];
  return Type === undefined ? value.clone() : new Type().copy(value);
}

class ReferenceResources {
  private readonly materials = new Map<Material, Material>();
  private readonly populated = new Set<Material>();
  private readonly textures = new Map<Texture, Texture>();

  private texture(value: Texture): Texture {
    let copy = this.textures.get(value);
    if (copy === undefined) {
      copy = value.clone();
      copy.onUpdate = null;
      this.textures.set(value, copy);
    }
    return copy;
  }

  private allocateMaterial(value: Material): Material {
    const existing = this.materials.get(value);
    if (existing !== undefined) return existing;
    const copy =
      'isNodeMaterialInstance' in value
        ? new OriginalNodeMaterialInstance(
            this.allocateMaterial(Reflect.get(value, 'nodeMaterial')) as OriginalNodeMaterial,
          ).copy(value as OriginalNodeMaterialInstance)
        : referenceMaterial(value);
    if ('isNodeMaterialInstance' in value)
      Reflect.set(copy, 'nodeMaterial', this.allocateMaterial(Reflect.get(value, 'nodeMaterial')));
    this.materials.set(value, copy);
    return copy;
  }

  private material(value: Material): Material {
    const copy = this.allocateMaterial(value);
    if (this.populated.has(value)) return copy;
    this.populated.add(value);
    if ('isNodeMaterialInstance' in value) this.material(Reflect.get(value, 'nodeMaterial'));
    else this.copyNodeInputs(value, copy);
    for (const [key, input] of Object.entries(value))
      if (input !== null && typeof input === 'object' && 'isTexture' in input)
        Reflect.set(copy, key, this.texture(input as Texture));
    return copy;
  }

  private copyNodeInputs(value: Material, copy: Material): void {
    for (const field of Object.keys(SURFACE_INPUTS)) {
      const node = (
        value as unknown as Record<
          string,
          {
            isMaterialReferenceNode?: boolean;
            type: string;
            object: object;
            userData: object;
            property: string;
            uniformType: string;
            material: Material | null;
            isTextureNode?: boolean;
            isUniformNode?: boolean;
            value: unknown;
            nodeType: string | null;
          } | null
        >
      )[field];
      if (node?.isMaterialReferenceNode === true) {
        const target = node.material ?? value;
        const targetCopy = node.material === null ? copy : this.material(target);
        const input = Reflect.get(target, node.property);
        Reflect.set(targetCopy, node.property, cloneInput(input));
        Reflect.set(
          copy,
          field,
          new OriginalMaterialReferenceNode(
            node.property,
            node.uniformType,
            node.material === null ? null : targetCopy,
          ),
        );
      } else if (
        node !== null &&
        node !== undefined &&
        ['ReferenceNode', 'ReferenceBaseNode', 'UserDataNode'].includes(node.type)
      ) {
        const target = node.type === 'UserDataNode' ? node.userData : node.object;
        const data = { [node.property]: cloneInput(Reflect.get(target, node.property)) };
        const cloned =
          node.type === 'UserDataNode'
            ? new OriginalUserDataNode(node.property, node.uniformType, data)
            : node.type === 'ReferenceBaseNode'
              ? new OriginalReferenceBaseNode(node.property, node.uniformType, data)
              : new OriginalReferenceNode(node.property, node.uniformType, data);
        Reflect.set(copy, field, cloned);
      } else if (node?.isTextureNode === true)
        Reflect.set(copy, field, new OriginalTextureNode(this.texture(node.value as Texture)));
      else if (node?.isUniformNode === true) {
        const sourceValue = node.value;
        const cloned = cloneInput(sourceValue);
        Reflect.set(copy, field, new OriginalUniformNode(cloned, node.nodeType));
      }
    }
  }

  copy(source: Object3D, copy: Object3D): void {
    if ('material' in source && 'material' in copy) {
      const input = (source as Mesh).material;
      (copy as Mesh).material = Array.isArray(input)
        ? input.map((value) => this.material(value))
        : this.material(input);
    }
    if ('isScene' in source && 'isScene' in copy) {
      const from = source as Scene,
        to = copy as Scene;
      if (from.background !== null && 'isTexture' in from.background)
        to.background = this.texture(from.background);
      if (from.environment !== null) to.environment = this.texture(from.environment);
      if (from.overrideMaterial !== null)
        to.overrideMaterial = this.material(from.overrideMaterial);
    }
  }

  dispose(): void {
    for (const material of this.materials.values()) material.dispose();
    for (const texture of this.textures.values()) texture.dispose();
  }
}

function cloneInput(value: unknown): unknown {
  return value !== null &&
    typeof value === 'object' &&
    'clone' in value &&
    typeof value.clone === 'function'
    ? value.clone()
    : value;
}
