import type { AssetHandle } from '@forgeax/engine-types';
import type { GameHost } from '@forgeax/engine-app';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { TransparentSort } from '@forgeax/engine-render/authoring';
import type { ChromaticAberrationHandle } from './chromatic-aberration';
import { createCustomProjectileMesh, type CustomProjectileMesh } from './custom-projectile-mesh';
import { createHitFlashMaterial } from './hit-flash-material';
import type { FbxMeshSwap } from './fbx-mesh-swap';
import type { GltfMeshSwap } from './gltf-mesh-swap';
import type { JpegTextureSwap } from './jpeg-texture-swap';
import type { MeshHandleSwap } from './mesh-handle-swap';
import { createSpriteAtlasLoop, type SpriteAtlasLoop } from './sprite-atlas-loop';
import { HitFlash, ProjectilePolicy, TargetPresentation, type ProjectileVisual } from './components/gameplay';

export type ProjectilePresentation = {
  dispose(): void;
  readonly bulletRadius: number;
  readonly bulletHalfHeight: number;
  readonly projectileMesh: AssetHandle<'mesh'>;
  readonly projectileMaterial: AssetHandle<'material'>;
  readonly hostileProjectileMaterial: AssetHandle<'material'>;
  readonly customProjectile: CustomProjectileMesh | undefined;
  readonly spriteAtlasLoop: SpriteAtlasLoop | undefined;
  readonly flashMaterial: AssetHandle<'material'>;
  readonly getProjectileVisual: () => ProjectileVisual;
  readonly setProjectileVisual: (visual: ProjectileVisual) => void;
  readonly materialsForCurrentMesh: (entity: EntityHandle, flashing: boolean) => readonly AssetHandle<'material'>[];
  readonly triggerFlash: (entity?: EntityHandle) => void;
  readonly multiMaterial: () => {
    readonly available: boolean;
    readonly materialCount: number;
    readonly submeshCount: number;
    readonly topologies: readonly string[];
    readonly slotsAligned: boolean;
  };
};

type ProjectilePresentationArgs = {
  readonly world: World;
  readonly host: GameHost | undefined;
  readonly player: EntityHandle | undefined;
  readonly primaryTarget: () => EntityHandle | undefined;
  readonly targetEntities: () => readonly EntityHandle[];
  readonly meshHandleSwap: MeshHandleSwap | undefined;
  readonly fbxMeshSwap: FbxMeshSwap | undefined;
  readonly gltfMeshSwap: GltfMeshSwap | undefined;
  readonly jpegTextureSwap: JpegTextureSwap | undefined;
  readonly chromaticAberration: ChromaticAberrationHandle;
};

/** Assemble projectile geometry, authored visual variants, and hit presentation. */
export async function createProjectilePresentation(args: ProjectilePresentationArgs): Promise<ProjectilePresentation> {
  const assets = args.host?.assets;
  if (assets === undefined) throw new Error('Projectile presentation requires the host AssetRegistry');
  const bulletRadius = 0.12;
  const bulletHalfHeight = 0.16;
  const hostileProjectileMaterial = assets.create(Materials.standard({
    baseColor: [1, 0.12, 0.02, 1],
    roughness: 0.32,
    metallic: 0.05,
    emissive: [1, 0.05, 0.01],
    emissiveIntensity: 7,
  })).unwrap();
  const customProjectile = await createCustomProjectileMesh(assets);
  const spriteAtlasLoop = await createSpriteAtlasLoop(args.world, assets, customProjectile.spriteMaterialHandle, customProjectile.spriteLitMaterialHandle);
  const projectileMesh = customProjectile.meshHandle;
  const projectileMaterial = customProjectile.materialHandle;
  const visualIndex = (visual: ProjectileVisual): number => visual === 'mesh' ? 0 : visual === 'sprite' ? 1 : 2;
  const visualValue = (value: number): ProjectileVisual => value === 1 ? 'sprite' : value === 2 ? 'sprite-lit' : 'mesh';
  const getProjectileVisual = (): ProjectileVisual => {
    if (args.player === undefined) return 'mesh';
    const policy = args.world.get(args.player, ProjectilePolicy);
    return policy.ok ? visualValue(policy.value.visualMode) : 'mesh';
  };
  const setProjectileVisual = (visual: ProjectileVisual): void => {
    if (args.player !== undefined) args.world.set(args.player, ProjectilePolicy, { visualMode: visualIndex(visual) });
    const sort = TransparentSort.configure(args.world, {
      mode: visual === 'mesh' ? TransparentSort.layerZ : TransparentSort.distance,
      yzAlpha: 1,
    });
    if (!sort.ok) console.error('[game] projectile transparent-sort setup failed:', sort.error.code, sort.error.expected, sort.error.hint);
  };
  setProjectileVisual('mesh');

  const flashMaterial = createHitFlashMaterial(assets);
  const materialsForCurrentMesh = (entity: EntityHandle, flashing: boolean): readonly AssetHandle<'material'>[] => {
    const presentation = args.world.get(entity, TargetPresentation);
    const original = presentation.ok ? presentation.value.authoredMaterials : [];
    const textured = args.jpegTextureSwap?.entity === entity && args.jpegTextureSwap.active === 'jpeg'
      ? args.jpegTextureSwap.jpegMaterials
      : original;
    const replacementHasOneSubmesh =
      (args.fbxMeshSwap?.entity === entity && args.fbxMeshSwap.active === 'fbx') ||
      (args.meshHandleSwap?.entity === entity && args.meshHandleSwap.active === 'alternate') ||
      (args.gltfMeshSwap?.entity === entity && args.gltfMeshSwap.active !== 'original');
    if (replacementHasOneSubmesh) return flashing ? [flashMaterial] : textured.slice(0, 1);
    return flashing ? [flashMaterial, ...textured.slice(1)] : [...textured];
  };
  const triggerFlash = (entity?: EntityHandle): void => {
    const target = entity === undefined ? args.primaryTarget() : entity;
    if (target === undefined) return;
    const flash = args.world.get(target, HitFlash);
    if (!flash.ok || flash.value.remaining > 0) return;
    args.world.set(target, MeshRenderer, { materials: [...materialsForCurrentMesh(target, true)] });
    args.world.set(target, HitFlash, { remaining: 0.2 });
    args.chromaticAberration.setIntensity(Math.max(args.chromaticAberration.snapshot().intensity, 0.035));
  };
  const multiMaterial = () => {
    const target = args.targetEntities().find((candidate) => {
      const presentation = args.world.get(candidate, TargetPresentation);
      return presentation.ok && presentation.value.authoredMaterials.length > 1;
    });
    if (target === undefined) return { available: false, materialCount: 0, submeshCount: 0, topologies: [], slotsAligned: false };
    const renderer = args.world.get(target, MeshRenderer);
    const filter = args.world.get(target, MeshFilter);
    const mesh = filter.ok ? assets.read(filter.value.assetHandle) : undefined;
    const materialCount = renderer.ok ? renderer.value.materials.length : 0;
    const submeshes = mesh?.ok === true ? mesh.value.submeshes : [];
    return {
      available: materialCount > 1 && materialCount === submeshes.length,
      materialCount,
      submeshCount: submeshes.length,
      topologies: submeshes.map((submesh) => submesh.topology),
      slotsAligned: materialCount === submeshes.length && materialCount > 1,
    };
  };

  return {
    dispose() {
      spriteAtlasLoop?.dispose();
      customProjectile.dispose();
      assets.release(hostileProjectileMaterial).unwrap();
      assets.release(flashMaterial).unwrap();
    },
    bulletRadius,
    bulletHalfHeight,
    projectileMesh,
    projectileMaterial,
    hostileProjectileMaterial,
    customProjectile,
    spriteAtlasLoop,
    flashMaterial,
    getProjectileVisual,
    setProjectileVisual,
    materialsForCurrentMesh,
    triggerFlash,
    multiMaterial,
  };
}
