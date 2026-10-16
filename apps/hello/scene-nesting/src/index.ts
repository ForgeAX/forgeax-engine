import { configureRuntimeAssetCatalog, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createWorldContext, World, type EntityHandle } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  renderComponentsPlugin,
  SceneInstance,
} from '@forgeax/engine-render';
import {
  Transform,
  scenePlugin,
  worldDespawnScene,
  worldInstantiateScene,
  worldSetSceneAssetResolver,
} from '@forgeax/engine-scene';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { err, ok, type Handle, type MaterialAsset, type MeshAsset, type SceneAsset } from '@forgeax/engine-types';

type MutableSceneEntity = {
  components: Record<string, Record<string, unknown>>;
  instance?: {
    source: string;
    overrides?: Array<{
      target: string[];
      components: Record<string, Record<string, unknown>>;
    }>;
  };
};

type MutableSceneAsset = {
  kind: 'scene';
  entities: Record<string, MutableSceneEntity>;
};

type ScenePair = {
  readonly inner: MutableSceneAsset;
  readonly outer: MutableSceneAsset;
  readonly innerHandle: Handle<'SceneAsset', 'shared'>;
  readonly outerHandle: Handle<'SceneAsset', 'shared'>;
  root: EntityHandle | undefined;
};

type SceneNestingReport = {
  readonly phase: 'baseline' | 'repaired' | 'cleaned' | 'error';
  readonly baseline?: Record<string, unknown>;
  readonly recovery?: Record<string, unknown>;
  readonly cleanup?: Record<string, unknown>;
  readonly error?: string;
};

const WIDTH = 800;
const HEIGHT = 600;

function cloneScene(asset: SceneSource): MutableSceneAsset {
  return structuredClone(asset) as unknown as MutableSceneAsset;
}

function sceneSnapshot(asset: MutableSceneAsset): string {
  return JSON.stringify(asset);
}

function entityAt(scene: MutableSceneAsset, key: string): MutableSceneEntity {
  const entity = scene.entities[key];
  if (entity === undefined) throw new Error(`scene entity key=${key} missing`);
  return entity;
}

function componentAt(
  scene: MutableSceneAsset,
  key: string,
  component: string,
): Record<string, unknown> {
  const data = entityAt(scene, key).components[component];
  if (data === undefined) throw new Error(`scene component ${component} on key=${key} missing`);
  return data;
}

type SceneSource = SceneAsset | MutableSceneAsset;

function bindRenderableScene(
  innerSource: SceneSource,
  outerSource: SceneSource,
  meshHandle: Handle<'MeshAsset', 'shared'>,
  materialHandle: Handle<'MaterialAsset', 'shared'>,
): { inner: MutableSceneAsset; outer: MutableSceneAsset } {
  const inner = cloneScene(innerSource);
  const outer = cloneScene(outerSource);
  const innerEntity = entityAt(inner, 'cube');
  innerEntity.components.MeshFilter = { assetHandle: meshHandle as unknown as number };
  innerEntity.components.MeshRenderer = {
    materials: [materialHandle as unknown as number],
  };

  const outerEntity = entityAt(outer, 'sibling');
  outerEntity.components.Transform = {
    ...outerEntity.components.Transform,
    pos: [-1, 0, 0],
  };
  outerEntity.components.MeshFilter = { assetHandle: meshHandle as unknown as number };
  outerEntity.components.MeshRenderer = {
    materials: [materialHandle as unknown as number],
  };
  return { inner, outer };
}

export async function bootstrap(canvas: HTMLCanvasElement): Promise<void> {
  const reportElement = document.getElementById('scene-nesting-report');
  const recoveryButton = document.getElementById('scene-nesting-recover') as HTMLButtonElement | null;
  const cleanupButton = document.getElementById('scene-nesting-cleanup') as HTMLButtonElement | null;
  const publish = (report: SceneNestingReport): void => {
    if (reportElement === null) return;
    reportElement.dataset.status = report.phase;
    reportElement.textContent = JSON.stringify(report);
  };

  try {
    const host = await constructRuntimeRendererHost(canvas);
    if (!host.ok) throw host.error;
    const { renderer, assets } = host.value;
    configureRuntimeAssetCatalog(assets, runtimeBinding);

    const unlitMatGuid = AssetGuid.parse('008e4f75-e7a3-4715-b05b-b93a9ec12074');
    const cubeGuid = AssetGuid.parse('cbe42beb-8975-5096-b3a1-3dda4cb4c077');
    const innerCubeGuid = AssetGuid.parse('f47ac10b-58cc-4372-a567-0e02b2c3d479');
    const outerSceneGuid = AssetGuid.parse('d07a7b8e-9c12-4f6b-a8e1-3d4f5a6b7c8d');
    if (!unlitMatGuid.ok || !cubeGuid.ok || !innerCubeGuid.ok || !outerSceneGuid.ok) {
      throw new Error('scene-nesting fixture GUID parse failed');
    }

    assets.catalog(unlitMatGuid.value, Materials.unlit([0.8, 0.4, 0.2, 1]));
    const [innerResult, outerResult, meshResult, materialResult] = await Promise.all([
      assets.loadByGuid<SceneAsset>(innerCubeGuid.value),
      assets.loadByGuid<SceneAsset>(outerSceneGuid.value),
      assets.loadByGuid<MeshAsset>(cubeGuid.value),
      assets.loadByGuid<MaterialAsset>(unlitMatGuid.value),
    ]);
    if (!innerResult.ok) throw new Error(`inner scene loadByGuid failed: ${innerResult.error.code}`);
    if (!outerResult.ok) throw new Error(`outer scene loadByGuid failed: ${outerResult.error.code}`);
    if (!meshResult.ok) throw new Error(`cube mesh loadByGuid failed: ${meshResult.error.code}`);
    if (!materialResult.ok) throw new Error(`unlit material loadByGuid failed: ${materialResult.error.code}`);

    const loadedInnerSnapshot = sceneSnapshot(cloneScene(innerResult.value));
    const loadedOuterSnapshot = sceneSnapshot(cloneScene(outerResult.value));
    const world = new World();
    const worldContext = await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
    void worldContext;
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    const lease = attachment.value;

    const meshHandle = world.allocSharedRef('MeshAsset', meshResult.value);
    const materialHandle = world.allocSharedRef('MaterialAsset', materialResult.value);
    const sceneChildren = new Map<number, Handle<'SceneAsset', 'shared'>>();
    worldSetSceneAssetResolver(world, (_source, parent) => {
      const child = sceneChildren.get(Number(parent));
      return child === undefined
        ? err({ code: 'asset-not-found', expected: 'outer scene handle', hint: 'scene pair not registered' })
        : ok(child);
    });

    const makePair = (innerSource: SceneSource, outerSource: SceneSource): ScenePair => {
      const bound = bindRenderableScene(innerSource, outerSource, meshHandle, materialHandle);
      const innerHandle = world.allocSharedRef('SceneAsset', bound.inner);
      const outerHandle = world.allocSharedRef('SceneAsset', bound.outer);
      sceneChildren.set(Number(outerHandle), innerHandle);
      return { ...bound, innerHandle, outerHandle, root: undefined };
    };

    const baselinePair = makePair(innerResult.value, outerResult.value);
    const camera = world.spawn(
      { component: Transform, data: { pos: [0, 1.5, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: Camera, data: { fov: 60, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 } },
    );
    if (!camera.ok) throw camera.error;

    const renderErrors: Array<{ code: string }> = [];
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      renderErrors.push({ code: event.error.code });
      const bus = (globalThis as unknown as { __learnRenderErrors?: unknown[] }).__learnRenderErrors;
      bus?.push(event.error);
      console.error('[hello-scene-nesting] renderer error:', event.error.code, event.error.hint);
    });

    const baselineInstance = worldInstantiateScene(world, baselinePair.outerHandle);
    if (!baselineInstance.ok) throw new Error(`baseline instantiate failed: ${baselineInstance.error.code}`);
    baselinePair.root = baselineInstance.value.root;
    const sceneInstanceToken = SceneInstance;
    const mappingFor = (root: EntityHandle): Uint32Array => {
      const instance = world.get(root, sceneInstanceToken);
      if (!instance.ok) throw new Error(`SceneInstance missing on root ${Number(root)}`);
      return instance.value.mapping;
    };
    const baselineMapping = mappingFor(baselinePair.root);
    const baselineSibling = baselineMapping[0] as unknown as EntityHandle;
    const baselineMountedMember = baselineMapping[2] as unknown as EntityHandle;
    const baselineSiblingRenderable = world.get(baselineSibling, MeshFilter).ok && world.get(baselineSibling, MeshRenderer).ok;
    const baselineMountedRenderable = world.get(baselineMountedMember, MeshFilter).ok && world.get(baselineMountedMember, MeshRenderer).ok;
    const baselineCount = world.inspect().entityCount;
    const baselineDiagnostics = baselineInstance.value.diagnostics;
    publish({
      phase: 'baseline',
      baseline: {
        diagnostics: baselineDiagnostics,
        root: Number(baselinePair.root),
        sibling: Number(baselineSibling),
        mountedMember: Number(baselineMountedMember),
        siblingRenderable: baselineSiblingRenderable,
        mountedRenderable: baselineMountedRenderable,
        entityCount: baselineCount,
      },
    });

    let frameLoop = true;
    const frame = (): void => {
      if (!frameLoop) return;
      const update = world.update();
      if (!update.ok) {
        console.error(`[hello-scene-nesting] world.update failed: ${update.error.code}`);
      } else {
        const draw = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
        if (!draw.ok) console.error(`[hello-scene-nesting] draw failed: ${draw.error.code}`);
        else void renderer.observe(draw.value, { include: ['draws'] });
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    const cleanupPair = (pair: ScenePair): { changed: boolean; count: number } => {
      if (pair.root === undefined) return { changed: false, count: 0 };
      const root = pair.root;
      if (!world.get(root, sceneInstanceToken).ok) {
        pair.root = undefined;
        return { changed: false, count: 0 };
      }
      const result = worldDespawnScene(world, root);
      if (!result.ok) throw result.error;
      sceneChildren.delete(Number(pair.outerHandle));
      pair.root = undefined;
      return { changed: true, count: result.value };
    };

    let displayPair: ScenePair | undefined;
    recoveryButton?.addEventListener('click', () => {
      if (recoveryButton.disabled) return;
      recoveryButton.disabled = true;
      try {
        const pair = makePair(innerResult.value, outerResult.value);
        componentAt(pair.inner, 'cube', 'Transform').unknownField = 'M30-unknown-field';
        const faultyInputSnapshot = sceneSnapshot(pair.inner);
        const faulty = worldInstantiateScene(world, pair.outerHandle);
        const faultyEntityCount = world.inspect().entityCount;
        const inputUnchanged = sceneSnapshot(pair.inner) === faultyInputSnapshot;
        const faultyError = faulty.ok
          ? undefined
          : (faulty.error as unknown as {
              readonly code?: string;
              readonly detail?: unknown;
            });
        const faultyDetail = faultyError?.detail as {
          readonly reason?: unknown;
          readonly component?: unknown;
          readonly field?: unknown;
          readonly entity?: unknown;
        } | undefined;
        const rejectedBeforeSpawn = faultyError?.code === 'asset-package-invalid'
          && faultyDetail?.reason === 'unknown component field'
          && faultyDetail.component === 'Transform'
          && faultyDetail.field === 'unknownField'
          && faultyDetail.entity === 'cube';
        const faultyCleanup = faulty.ok ? cleanupPair(pair) : { changed: false, count: 0 };
        const noOrphanAfterFault = world.inspect().entityCount === baselineCount;
        const healthyRetainedAfterFault = world.get(baselinePair.root as EntityHandle, sceneInstanceToken).ok;
        sceneChildren.delete(Number(pair.outerHandle));
        world.sharedRefs.release(pair.innerHandle);
        world.sharedRefs.release(pair.outerHandle);

        const correctedInner = cloneScene(pair.inner);
        delete componentAt(correctedInner, 'cube', 'Transform').unknownField;
        const correctedOuter = cloneScene(pair.outer);
        const correctedInputSnapshot = sceneSnapshot(correctedInner);
        const correctedPair = makePair(correctedInner, correctedOuter);
        const corrected = worldInstantiateScene(world, correctedPair.outerHandle);
        if (!corrected.ok) throw new Error(`corrected instantiate failed: ${corrected.error.code}`);
        correctedPair.root = corrected.value.root;
        const correctedMapping = mappingFor(corrected.value.root);
        const correctedMember = correctedMapping[2] as unknown as EntityHandle;
        const correctedEntityCount = world.inspect().entityCount;
        const correctionInputUnchanged = sceneSnapshot(correctedInner) === correctedInputSnapshot;
        const freshIdentity = Number(correctedPair.root) !== Number(baselinePair.root)
          && Number(correctedMember) !== Number(baselineMountedMember);
        const correctedEmpty = corrected.value.diagnostics.length === 0;
        const healthyRetained = world.get(baselinePair.root as EntityHandle, sceneInstanceToken).ok;
        const loadedInputsUnchanged = sceneSnapshot(cloneScene(innerResult.value)) === loadedInnerSnapshot
          && sceneSnapshot(cloneScene(outerResult.value)) === loadedOuterSnapshot;

        publish({
          phase: 'repaired',
          baseline: {
            diagnostics: baselineDiagnostics,
            entityCount: baselineCount,
            healthyRetained,
          },
          recovery: {
            rejectedBeforeSpawn,
            error: faultyError,
            faultyEntityCount,
            noOrphanAfterFault,
            healthyRetainedAfterFault,
            healthyRetained,
            inputUnchanged,
            faultyCleanup,
            correctedDiagnostics: corrected.value.diagnostics,
            correctedEmpty,
            correctedInputUnchanged: correctionInputUnchanged,
            loadedInputsUnchanged,
            freshIdentity,
            correctedEntityCount,
            rendererErrors: renderErrors,
          },
        });

        // Keep the corrected instance alive for the Chrome pixel readback. The
        // cleanup button owns the final teardown and calls this same wrapper
        // twice to prove its no-op second invocation is safe.
        displayPair = correctedPair;
        if (cleanupButton !== null) cleanupButton.disabled = false;
      } catch (error) {
        publish({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
        console.error('[hello-scene-nesting] recovery failed:', error);
      }
    });

    cleanupButton?.addEventListener('click', () => {
      if (cleanupButton.disabled) return;
      cleanupButton.disabled = true;
      try {
        if (displayPair === undefined) throw new Error('run recovery before cleanup');
        const first = cleanupPair(displayPair);
        const second = cleanupPair(displayPair);
        const healthyRetainedBeforeFinalTeardown = world.get(baselinePair.root as EntityHandle, sceneInstanceToken).ok;
        const baselineCleanup = cleanupPair(baselinePair);
        world.despawn(camera.value).unwrap();
        world.sharedRefs.release(displayPair.innerHandle);
        world.sharedRefs.release(displayPair.outerHandle);
        world.sharedRefs.release(baselinePair.innerHandle);
        world.sharedRefs.release(baselinePair.outerHandle);
        world.sharedRefs.release(meshHandle);
        world.sharedRefs.release(materialHandle);
        frameLoop = false;
        publish({
          phase: 'cleaned',
          cleanup: {
            first,
            second,
            idempotent: second.changed === false,
            healthyRetainedBeforeFinalTeardown,
            baselineCleanup,
            finalEntityCount: world.inspect().entityCount,
            sharedRefCounts: {
              mesh: world.sharedRefs.refcount(meshHandle),
              material: world.sharedRefs.refcount(materialHandle),
              displayInner: world.sharedRefs.refcount(displayPair.innerHandle),
              displayOuter: world.sharedRefs.refcount(displayPair.outerHandle),
              baselineInner: world.sharedRefs.refcount(baselinePair.innerHandle),
              baselineOuter: world.sharedRefs.refcount(baselinePair.outerHandle),
            },
            rendererErrors: renderErrors,
          },
        });
      } catch (error) {
        publish({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
        console.error('[hello-scene-nesting] cleanup failed:', error);
      }
    });
  } catch (error) {
    publish({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
