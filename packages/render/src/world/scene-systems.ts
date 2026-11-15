import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { defineResource, defineSystem } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { RenderFeatureSource } from '../features/source';
import type { PreparedRenderPublication } from '../publication/receiver';
import type { ReflectionProbeFact } from '../reflection/projection';
import type { ExtractedFrame, LightRoster } from '../render-system-extract';
import type {
  PersistentRenderCandidateRequest,
  SceneAdvance,
  SceneComposition,
  SceneStage,
} from '../scene/scene-composition';
import { RenderSceneOrder, RenderScenePublishOrder } from '../system-order';
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
  world: World | undefined;
  lease: RenderReadLease | undefined;
  buildCandidateFrame: ((request: PersistentRenderCandidateRequest) => ExtractedFrame) | undefined;
  captureFeatures?: ((frame: ExtractedFrame) => readonly RenderFeatureSource[]) | undefined;
}

/**
 * This frame's shared scene adoption: the composition advance every recording
 * view follows. The systems never throw; the first adoption failure of the
 * frame is stored once, gates every later row step, and each view's
 * extraction rethrows it, keeping the record-side recovery.
 */
export interface RenderSceneAdoption {
  featureSources?: readonly RenderFeatureSource[] | undefined;
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
export const RenderSceneInput = defineResource<RenderSceneSource>('RenderSceneInput');
export const RenderSceneDelta = defineResource<RenderSceneAdoption>('RenderSceneDelta');
export const RenderSceneRows = defineResource<RenderSceneRowStore>('RenderSceneRows');
export const RenderLightInput = defineResource<RenderLightSource>('RenderLightInput');
export const RenderProbeInput = defineResource<RenderProbeSource>('RenderProbeInput');

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
    world: undefined,
    lease: undefined,
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
  const systemToken1 = defineSystem({
    sets: [RenderSceneOrder],
    name: RENDER_SCENE_SYSTEM,
    queries: [],
    fn: adoptScene,
  });
  world.addSystem(RenderExtract, systemToken1).unwrap();
  registerAdoptionSystems(world, composition);
  const systemToken2 = defineSystem({
    sets: [RenderScenePublishOrder],
    name: RENDER_SCENE_PUBLISH_SYSTEM,
    queries: [],
    fn: sceneRowStep(world, (stage, scene) => scene.publishStage(stage)),
  });
  world.addSystem(RenderPrepare, systemToken2).unwrap();
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
  const cursor = world.getResource(RenderSceneRows).cursor();
  return (frameWorld) => {
    const adoption = frameWorld.getResource(RenderSceneDelta);
    const rows = frameWorld.getResource(RenderSceneRows);
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
  const source = world.getResource(RenderSceneInput);
  const adoption = world.getResource(RenderSceneDelta);
  const rows = world.getResource(RenderSceneRows);
  adoption.advance = undefined;
  adoption.failure = undefined;
  adoption.featureSources = undefined;
  rows.append(undefined);
  if (!source.staged) return;
  source.staged = false;
  const { publication, lease } = source;
  const build = source.buildCandidateFrame;
  source.publication = source.lease = source.buildCandidateFrame = undefined;
  const lights = world.getResource(RenderLightInput);
  const probes = world.getResource(RenderProbeInput);
  try {
    if (publication !== undefined) {
      const consumed = source.composition.consume(publication);
      adoption.advance = consumed.advance;
      rows.append(consumed.stage);
      lights.roster = publication.frame.lights;
      probes.facts = publication.frame.reflectionProbes ?? NO_PROBES;
    } else if (build !== undefined) {
      if (source.assets === undefined || source.world === undefined || lease === undefined)
        throw new Error('Source-World scene adoption requires an asset registry');
      const adopted = source.composition.extract(source.world, source.assets, build, lease);
      adoption.featureSources = source.captureFeatures?.(adopted.resourceFrame);
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
  const systemToken3 = defineSystem({
    commands: 'none',
    name: SKIN_INPUTS_SYSTEM,
    queries: [],
    after: [RenderSceneOrder],
    fn: (world) => {
      const adoption = world.getResource(RenderSceneDelta);
      if (adoption.failure !== undefined) return composition.discardAdoption();
      try {
        composition.adoptSkinInputs();
      } catch (cause) {
        adoption.failure = cause;
      }
    },
  });
  world.addSystem(RenderExtract, systemToken3).unwrap();
  const systemToken4 = defineSystem({
    commands: 'none',
    name: INSTANCE_COLLECTIONS_SYSTEM,
    queries: [],
    after: [RenderSceneOrder, systemToken3],
    fn: (world) => {
      const adoption = world.getResource(RenderSceneDelta);
      if (adoption.failure !== undefined) return composition.discardAdoption();
      try {
        composition.adoptInstanceCollections();
      } catch (cause) {
        adoption.failure = cause;
      }
    },
  });
  world.addSystem(RenderExtract, systemToken4).unwrap();
}
