import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { PreparedRenderPublication } from '../publication/receiver';
import type { ReflectionProbeFact } from '../reflection/projection';
import type { ExtractedFrame, LightRoster } from '../render-system-extract';
import type {
  PersistentRenderCandidateRequest,
  SceneAdvance,
  SceneComposition,
  SceneStage,
} from '../scene/scene-composition';
import { RenderExtract, RenderPrepare } from './render-world';
import { RenderSceneRowStore } from './scene-row-store';

/** System name other Render World systems order against. */
export const RENDER_SCENE_SYSTEM = 'render-scene';
/**
 * RenderPrepare system that syncs the GPU Scene owner from the adopted
 * materials and accepts the staged observation; steps of the staged rows
 * order before it.
 */
export const RENDER_SCENE_PUBLISH_SYSTEM = 'render-scene-publish';

/**
 * The frame's scene source. The composition-owning recorder stages it before
 * `beginRenderFrame`; the `render-scene` system consumes it once.
 */
export interface RenderSceneSource {
  readonly composition: SceneComposition;
  assets: AssetRegistry | undefined;
  staged: boolean;
  publication: PreparedRenderPublication | undefined;
  worlds: readonly World[];
  owner: { cameraOwner: number; resourceOwner: number };
  leases: readonly RenderReadLease[] | undefined;
  buildCandidateFrame: ((request: PersistentRenderCandidateRequest) => ExtractedFrame) | undefined;
}

/**
 * This frame's shared scene adoption: the composition advance every recording
 * view follows. The systems never throw; the first adoption failure of the
 * frame is stored once, gates every later row step, and each view's
 * extraction rethrows it, keeping the record-side recovery.
 */
export interface RenderSceneAdoption {
  advance: SceneAdvance | undefined;
  failure: unknown;
}

/** The frame's camera-independent light roster, adopted with the scene. */
export interface RenderLightSource {
  roster: LightRoster | undefined;
}

/** The frame's camera-independent reflection probe facts, adopted with the scene. */
export interface RenderProbeSource {
  facts: readonly ReflectionProbeFact[];
}

/** World resource keys of the scene source, its adoption, its row store and the light roster. */
export const RenderSceneInput = Object.freeze({ name: 'RenderSceneInput' });
export const RenderSceneDelta = Object.freeze({ name: 'RenderSceneDelta' });
export const RenderSceneRows = Object.freeze({ name: 'RenderSceneRows' });
export const RenderLightInput = Object.freeze({ name: 'RenderLightInput' });
export const RenderProbeInput = Object.freeze({ name: 'RenderProbeInput' });

/**
 * Register the `render-scene` RenderExtract system: it adopts the staged
 * source Worlds or publication into the Renderer's one shared composition
 * (`SceneComposition.extract`/`consume`). Returns the retained source the
 * frame entry rewrites.
 */
export function registerSceneSystem(
  world: World,
  composition: SceneComposition,
  assets: AssetRegistry | undefined,
): RenderSceneSource {
  const source: RenderSceneSource = {
    composition,
    assets,
    staged: false,
    publication: undefined,
    worlds: [],
    owner: { cameraOwner: 0, resourceOwner: 0 },
    leases: undefined,
    buildCandidateFrame: undefined,
  };
  world.insertResource(RenderSceneInput, source);
  world.insertResource<RenderSceneAdoption>(RenderSceneDelta, {
    advance: undefined,
    failure: undefined,
  });
  const rows = new RenderSceneRowStore(composition);
  world.insertResource(RenderSceneRows, rows);
  world.insertResource(RenderLightInput, { roster: undefined });
  world.insertResource<RenderProbeSource>(RenderProbeInput, { facts: [] });
  world
    .addSystem(RenderExtract, { name: RENDER_SCENE_SYSTEM, queries: [], fn: adoptScene })
    .unwrap();
  registerAdoptionSystems(world, composition);
  world
    .addSystem(RenderPrepare, {
      name: RENDER_SCENE_PUBLISH_SYSTEM,
      queries: [],
      fn: sceneRowStep(world, (stage, scene) => scene.publishStage(stage)),
    })
    .unwrap();
  return source;
}

/**
 * One RenderPrepare row-step system body. It holds its own cursor into the
 * `RenderSceneRows` journal and consumes each applied step once; it is
 * skipped when nothing new was applied or an earlier step failed, and its own
 * failure becomes the frame's adoption failure.
 */
export function sceneRowStep(
  world: World,
  step: (stage: SceneStage, composition: SceneComposition) => void,
): (frameWorld: World) => void {
  const cursor = world.getResource<RenderSceneRowStore>(RenderSceneRows).cursor();
  return (frameWorld) => {
    const adoption = frameWorld.getResource<RenderSceneAdoption>(RenderSceneDelta);
    const rows = frameWorld.getResource<RenderSceneRowStore>(RenderSceneRows);
    try {
      const stage = rows.next(cursor, adoption);
      if (stage !== undefined) step(stage, rows.composition);
    } catch (cause) {
      adoption.failure = cause;
    }
  };
}

const NO_PROBES: readonly ReflectionProbeFact[] = Object.freeze([]);

function adoptScene(world: World): void {
  const source = world.getResource<RenderSceneSource>(RenderSceneInput);
  const adoption = world.getResource<RenderSceneAdoption>(RenderSceneDelta);
  const rows = world.getResource<RenderSceneRowStore>(RenderSceneRows);
  adoption.advance = undefined;
  adoption.failure = undefined;
  rows.append(undefined);
  if (!source.staged) return;
  source.staged = false;
  const { publication, leases } = source;
  const build = source.buildCandidateFrame;
  source.publication = source.leases = source.buildCandidateFrame = undefined;
  const lights = world.getResource<RenderLightSource>(RenderLightInput);
  const probes = world.getResource<RenderProbeSource>(RenderProbeInput);
  try {
    if (publication !== undefined) {
      const consumed = source.composition.consume(publication);
      adoption.advance = consumed.advance;
      rows.append(consumed.stage);
      lights.roster = publication.frame.lights;
      probes.facts = publication.frame.reflectionProbes ?? NO_PROBES;
    } else if (build !== undefined) {
      if (source.assets === undefined)
        throw new Error('Source-World scene adoption requires an asset registry');
      const adopted = source.composition.extract(
        source.worlds,
        source.owner,
        source.assets,
        build,
        leases,
      );
      adoption.advance = adopted.advance;
      rows.append(adopted.stage);
      lights.roster = adopted.resourceFrame.lights;
      probes.facts = adopted.resourceFrame.reflectionProbes ?? NO_PROBES;
    }
  } catch (cause) {
    adoption.failure = cause;
  }
}

/** System names of the adoption stages that follow `render-scene`. */
export const SKIN_INPUTS_SYSTEM = 'skin-inputs';
export const INSTANCE_COLLECTIONS_SYSTEM = 'instance-collections';

/**
 * Register the adoption systems that consume the step `render-scene` observed:
 * `skin-inputs` applies Skin palette/joint changes and `instance-collections`
 * settles accepted Instances collections. A failed scene step discards both;
 * a Skin failure retires the composition and joins the frame's adoption failure
 * so each view's extraction rethrows it.
 */
export function registerAdoptionSystems(world: World, composition: SceneComposition): void {
  world
    .addSystem(RenderExtract, {
      commands: 'none',
      name: SKIN_INPUTS_SYSTEM,
      queries: [],
      after: [RENDER_SCENE_SYSTEM],
      fn: (world) => {
        const adoption = world.getResource<RenderSceneAdoption>(RenderSceneDelta);
        if (adoption.failure !== undefined) return composition.discardAdoption();
        try {
          composition.adoptSkinInputs();
        } catch (cause) {
          adoption.failure = cause;
        }
      },
    })
    .unwrap();
  world
    .addSystem(RenderExtract, {
      commands: 'none',
      name: INSTANCE_COLLECTIONS_SYSTEM,
      queries: [],
      after: [RENDER_SCENE_SYSTEM, SKIN_INPUTS_SYSTEM],
      fn: (world) => {
        const adoption = world.getResource<RenderSceneAdoption>(RenderSceneDelta);
        if (adoption.failure !== undefined) return composition.discardAdoption();
        try {
          composition.adoptInstanceCollections();
        } catch (cause) {
          adoption.failure = cause;
        }
      },
    })
    .unwrap();
}
