import type { GameHost } from '@forgeax/engine-app';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import type { Context } from '@forgeax/engine-plugin';
import { installAssetContentEvidence } from './asset-content-evidence';
import { createFbxMeshSwap, resetFbxMeshSwap, type FbxMeshSwap } from './fbx-mesh-swap';
import { createFbxSkinnedTarget, type FbxSkinnedTarget } from './fbx-skinned-target';
import { createGltfMeshSwap, resetGltfMeshSwap, type GltfMeshSwap } from './gltf-mesh-swap';
import { createJpegTextureSwap, resetJpegTextureSwap, type JpegTextureSwap } from './jpeg-texture-swap';
import { createMeshHandleSwap, resetMeshHandleSwap, type MeshHandleSwap } from './mesh-handle-swap';
import { createTargetProfileLoop, targetProfileSnapshot, toggleTargetProfile, type TargetProfileLoop } from './target-profile-loop';
import { targetProfileLoader } from './target-profile-loader';
import { createVideoTexturePanel, type VideoTexturePanel } from './video-texture-panel';
import { installTargetDisabling, type TargetDisablingHandle } from './target-disabling';
import { installTargetHealth, TargetHealth, type TargetHealthHandle } from './target-health';
import { installVisibilityLoop, type VisibilityLoopHandle } from './visibility-loop';
import { firstScoringTarget, scoringTargetEntities } from './scoring-target';
import { assembleGameplayScene, type GameplaySceneAssembly } from './gameplay-scene';
import { createTargetRelay, type TargetRelayHandle } from './target-relay';
import { createResonanceForge, type ResonanceForge } from './resonance-forge';

export type GameplayTargetFeatures = GameplaySceneAssembly & {
  readonly targetEntities: () => EntityHandle[];
  readonly primaryTarget: () => EntityHandle | undefined;
  readonly targetHealth: TargetHealthHandle;
  readonly targetDisabling: TargetDisablingHandle;
  readonly visibilityLoop: VisibilityLoopHandle;
  readonly meshHandleSwap: MeshHandleSwap | undefined;
  readonly fbxMeshSwap: FbxMeshSwap | undefined;
  readonly gltfMeshSwap: GltfMeshSwap | undefined;
  readonly jpegTextureSwap: JpegTextureSwap | undefined;
  readonly videoTexturePanel: VideoTexturePanel | undefined;
  readonly targetProfile: TargetProfileLoop | undefined;
  readonly toggleProfile: () => ReturnType<typeof targetProfileSnapshot>;
  readonly fbxSkinnedTarget: FbxSkinnedTarget | undefined;
  readonly targetRelay: TargetRelayHandle;
  readonly resonanceForge: ResonanceForge;
  readonly damageTarget: (entity: EntityHandle, points: number) => void;
};

export type GameplayTargetOptions = {
  /** Load comparison-only mesh/FBX/glTF/skin owners for an explicit evidence run. */
  readonly comparisonEvidenceMode?: boolean;
};

/** Assemble the target roster and the guided asset loops around it. */
export async function createGameplayTargetFeatures(
  context: Context,
  world: World,
  host: GameHost | undefined,
  options: GameplayTargetOptions = {},
): Promise<GameplayTargetFeatures> {
  const scene = await assembleGameplayScene(world, host, context.capabilityScene);
  const targetEntities = (): EntityHandle[] => scoringTargetEntities(scene.targetQuery);
  const primaryTarget = (): EntityHandle | undefined => firstScoringTarget(world, scene.targetQuery);
  const targetHealth = installTargetHealth(world, scene.targetQuery);
  const targetDisabling = installTargetDisabling(world, scene.targetQuery);
  const visibilityLoop = installVisibilityLoop(world, scene.targetQuery);
  // Mesh/FBX/glTF swaps remain comparison owners. The imported humanoid is also
  // prepared as a hidden guided companion so one Asset Lab action can turn the
  // existing scored target into a real source-format lesson without creating a
  // second gameplay owner.
  const comparisonEvidenceMode = options.comparisonEvidenceMode === true;
  const meshHandleSwap = comparisonEvidenceMode ? createMeshHandleSwap(world, primaryTarget()) : undefined;
  const fbxMeshSwap = comparisonEvidenceMode ? await createFbxMeshSwap(world, host?.assets, primaryTarget()) : undefined;
  const gltfMeshSwap = comparisonEvidenceMode ? await createGltfMeshSwap(world, host?.assets, primaryTarget()) : undefined;

  const assets = host?.assets;
  if (assets !== undefined) {
    context.effect(
      () => assets.loaders.register(targetProfileLoader()),
      'game-default/target-profile-loader',
    );
  }

  // These authored presentations use independent GUIDs and retain their own
  // owners. Start their ordinary AssetRegistry reads together so a cold Pack
  // producer does not serialize optional lab assets inside one plugin start.
  const guidedFbxTarget = primaryTarget();
  const physics = world.hasResource('PhysicsWorld') ? world.getResource<PhysicsWorld>('PhysicsWorld') : undefined;
  const [resonanceForge, jpegTextureSwap, videoTexturePanel, targetProfile, fbxSkinnedTarget] = await Promise.all([
    createResonanceForge(world, host?.assets),
    createJpegTextureSwap(world, host?.assets, primaryTarget()),
    createVideoTexturePanel(world, host?.assets, primaryTarget()),
    createTargetProfileLoop(world, host?.assets, primaryTarget()),
    createFbxSkinnedTarget(
      guidedFbxTarget === undefined
        ? { world, assets: host?.assets }
        : { world, assets: host?.assets, target: guidedFbxTarget, ...(physics === undefined ? {} : { physics }) },
    ),
  ]);
  context.effect(() => () => resonanceForge.dispose(), 'game-default/resonance-forge');
  context.effect(() => () => videoTexturePanel?.dispose(), 'game-default/video-texture-panel');
  context.effect(() => () => fbxSkinnedTarget?.dispose(), 'game-default/fbx-skinned-target');

  const toggleProfile = (): ReturnType<typeof targetProfileSnapshot> => {
    if (targetProfile === undefined) return targetProfileSnapshot(undefined);
    if (targetProfile.active === 'original') {
      resetMeshHandleSwap(world, meshHandleSwap);
      resetFbxMeshSwap(world, fbxMeshSwap);
      resetGltfMeshSwap(world, gltfMeshSwap);
      resetJpegTextureSwap(world, jpegTextureSwap);
    }
    toggleTargetProfile(world, targetProfile);
    return targetProfileSnapshot(targetProfile);
  };
  // Render-evidence mode adds comparison mesh owners, but the authored relay
  // still needs its FBX companion on RedBox. Keep that guided presentation
  // target-bound in every mode; the comparison swaps remain independent.
  const relayVariation = guidedFbxTarget === undefined || fbxSkinnedTarget === undefined
    ? undefined
    : {
        variationTarget: guidedFbxTarget,
        variationAvailable: true,
        setVariationActive: (active: boolean) => {
          if (fbxSkinnedTarget.companionActive() !== active) fbxSkinnedTarget.toggleCompanion();
        },
      };
  const targetRelay = createTargetRelay(world, scene.targetQuery, relayVariation);

  const skylightEntity = scene.loaded?.nodes
    .find((node) => (node.components.Name as { value?: string } | undefined)?.value === 'Skylight')
    ?.localId;
  installAssetContentEvidence({
    context,
    assets: host?.assets,
    renderer: host?.renderer,
    world,
    skylight: skylightEntity === undefined ? undefined : scene.loaded?.mapping.get(skylightEntity),
  });

  const damageTarget = (entity: EntityHandle, points: number): void => {
    targetHealth.damage(entity, points);
    const health = world.get(entity, TargetHealth);
    if (health.ok && health.value.current <= 0) targetDisabling.disable(entity);
  };

  return {
    ...scene,
    targetEntities,
    primaryTarget,
    targetHealth,
    targetDisabling,
    visibilityLoop,
    meshHandleSwap,
    fbxMeshSwap,
    gltfMeshSwap,
    jpegTextureSwap,
    videoTexturePanel,
    targetProfile,
    toggleProfile,
    fbxSkinnedTarget,
    targetRelay,
    resonanceForge,
    damageTarget,
  };
}
