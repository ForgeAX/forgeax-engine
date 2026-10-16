import type { GameHost } from '@forgeax/engine-app';
import { HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { createCapsuleGeometry } from '@forgeax/engine-geometry';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { TransparentSort } from '@forgeax/engine-render/authoring';
import type { Handle, MaterialAsset } from '@forgeax/engine-runtime';
import type { MeshAsset } from '@forgeax/engine-types';
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
  readonly bulletRadius: number;
  readonly bulletHalfHeight: number;
  readonly projectileMesh: Handle<'MeshAsset', 'shared'>;
  readonly projectileMaterial: Handle<'MaterialAsset', 'shared'>;
  readonly hostileProjectileMaterial: Handle<'MaterialAsset', 'shared'>;
  readonly customProjectile: CustomProjectileMesh | undefined;
  readonly spriteAtlasLoop: SpriteAtlasLoop | undefined;
  readonly flashMaterial: Handle<'MaterialAsset', 'shared'>;
  readonly getProjectileVisual: () => ProjectileVisual;
  readonly setProjectileVisual: (visual: ProjectileVisual) => void;
  readonly materialsForCurrentMesh: (entity: EntityHandle, flashing: boolean) => readonly Handle<'MaterialAsset', 'shared'>[];
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
  const bulletRadius = 0.12;
  const bulletHalfHeight = 0.16;
  const bulletMaterial = args.world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({
    baseColor: [1, 0.85, 0.3, 1],
    roughness: 0.4,
    metallic: 0,
    emissive: [1, 0.7, 0.15],
    emissiveIntensity: 5,
  }));
  const bulletMeshResult = createCapsuleGeometry(bulletRadius, bulletHalfHeight * 2, 6, 12);
  const hostileProjectileMaterial = args.world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({
    baseColor: [1, 0.12, 0.02, 1],
    roughness: 0.32,
    metallic: 0.05,
    emissive: [1, 0.05, 0.01],
    emissiveIntensity: 7,
  }));
  const bulletMesh = bulletMeshResult.ok ? args.world.allocSharedRef('MeshAsset', bulletMeshResult.value) : HANDLE_SPHERE;
  const customProjectile = args.host === undefined
    ? undefined
    : await createCustomProjectileMesh(args.world);
  const spriteAtlasLoop = customProjectile === undefined
    ? undefined
    : await createSpriteAtlasLoop(args.world, args.host?.assets, customProjectile.spriteMaterialHandle, customProjectile.spriteLitMaterialHandle);
  const projectileMesh = customProjectile?.meshHandle ?? bulletMesh;
  const projectileMaterial = customProjectile?.materialHandle ?? bulletMaterial;
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

  const flashMaterial = createHitFlashMaterial(args.world);
  const materialsForCurrentMesh = (entity: EntityHandle, flashing: boolean): readonly Handle<'MaterialAsset', 'shared'>[] => {
    const presentation = args.world.get(entity, TargetPresentation);
    const original = presentation.ok ? presentation.value.authoredMaterials : [];
    const textured = args.jpegTextureSwap?.entity === entity && args.jpegTextureSwap.active === 'jpeg'
      ? args.jpegTextureSwap.jpegMaterials
      : original;
    const replacementHasOneSubmesh =
      (args.fbxMeshSwap?.entity === entity && args.fbxMeshSwap.active === 'fbx') ||
      (args.meshHandleSwap?.entity === entity && args.meshHandleSwap.active === 'alternate') ||
      (args.gltfMeshSwap?.entity === entity && args.gltfMeshSwap.active !== 'original');
    if (replacementHasOneSubmesh) return [flashing ? flashMaterial : (textured[0] ?? (0 as Handle<'MaterialAsset', 'shared'>))];
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
    const mesh = filter.ok ? args.world.sharedRefs.resolve<'MeshAsset', MeshAsset>(filter.value.assetHandle) : undefined;
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
