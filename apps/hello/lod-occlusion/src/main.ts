import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createWorldContext, type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  CameraView,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  renderComponentsPlugin,
  Skylight,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import lodMeta from '../assets/lod-scene.gltf.meta.json' with { type: 'json' };
import {
  catalogLodProducerAssets,
  createLodPhaseProgress,
  createSerialFrameQueue,
  type LodProducerIdentity,
  observeCompletedReceipt,
  selectedLod,
  summarizeHiddenObservation,
  summarizeLodObservation,
  verifyLodProducerManifestBytes,
} from '../scripts/lod-acceptance-evidence.mjs';

type SubAssetEntry = { readonly guid: string; readonly kind: string };
const canvas = document.querySelector<HTMLCanvasElement>('#app');
const status = document.querySelector<HTMLPreElement>('#status');
const lodLevel = document.querySelector<HTMLElement>('#lod-level');
const lodDetail = document.querySelector<HTMLElement>('#lod-detail');
const lodGeometry = document.querySelector<HTMLElement>('#lod-geometry');
const multiViewDetail = document.querySelector<HTMLElement>('#multi-view-detail');
if (!canvas) throw new Error('hello-lod-occlusion: missing <canvas id="app">');

canvas.tabIndex = 0;
canvas.style.touchAction = 'none';

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[hello-lod-occlusion] no usable backend', error);
  } else {
    console.error('[hello-lod-occlusion] bootstrap failed', error);
  }
  if (status) status.textContent = `LOD runtime failed: ${String(error)}`;
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const constructed = await constructRuntimeRendererHost(
    target,
    {},
    {
      ...forgeaxBundlerAdapter(),
      importTransport: createRuntimeAssetImportTransport(runtimeBinding),
    },
  );
  if (!constructed.ok) throw constructed.error;
  const { renderer, assets } = constructed.value;
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  const world = new World();
  const worldContext = await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);

  const meshEntries = (
    lodMeta.subAssets as readonly (SubAssetEntry & { readonly sourceIndex?: number })[]
  )
    .filter((candidate) => candidate.kind === 'mesh')
    .sort((left, right) => (left.sourceIndex ?? 0) - (right.sourceIndex ?? 0));
  const rootGuid = guidAt(meshEntries, 0);
  const middleGuid = guidAt(meshEntries, 1);
  const lowestGuid = guidAt(meshEntries, 2);
  const sceneGuid = findGuid('scene');
  const expectedProducerRoles = {
    root: AssetGuid.format(rootGuid),
    middle: AssetGuid.format(middleGuid),
    lowest: AssetGuid.format(lowestGuid),
    material: AssetGuid.format(findGuid('material')),
    scene: AssetGuid.format(sceneGuid),
  };
  const configuredInputs = (
    globalThis as typeof globalThis & {
      __forgeaxLodIncrementalInputs?: LodProducerIdentity & { readonly manifestUrl: string };
    }
  ).__forgeaxLodIncrementalInputs;
  let producerAdmission: Awaited<ReturnType<typeof catalogLodProducerAssets>> | undefined;
  let producerInputEvidence:
    | {
        readonly producerHead: string;
        readonly manifestSha256: string;
        readonly shaderPublicationSha256: string;
        readonly gpuReadiness: 'unverified';
        readonly admission: 'incremental-catalog';
      }
    | undefined;
  let rootMeshValue: MeshAsset;
  if (configuredInputs !== undefined) {
    if (typeof configuredInputs.manifestUrl !== 'string' || !configuredInputs.manifestUrl)
      throw new Error('E03 selected input must include a manifest URL');
    const manifestUrl = new URL(configuredInputs.manifestUrl, window.location.href);
    const manifestResponse = await fetch(manifestUrl);
    if (!manifestResponse.ok)
      throw new Error(`E03 producer manifest fetch failed: ${manifestResponse.status}`);
    const verified = await verifyLodProducerManifestBytes(
      new Uint8Array(await manifestResponse.arrayBuffer()),
      expectedProducerRoles,
      configuredInputs,
    );
    const assetBaseUrl = new URL('.', manifestUrl);
    const producerReadBytes = async (path: string): Promise<Uint8Array> => {
      const url = new URL(path, assetBaseUrl);
      if (url.origin !== assetBaseUrl.origin)
        throw new Error('E03 producer asset escaped its manifest origin');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`E03 producer asset fetch failed: ${path}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    producerAdmission = await catalogLodProducerAssets(
      assets,
      verified.manifest,
      producerReadBytes,
      expectedProducerRoles,
    );
    const stagedRoot = assets.lookup<MeshAsset>(rootGuid);
    if (stagedRoot?.kind !== 'mesh' || assets.lookup(middleGuid)?.kind !== 'mesh')
      throw new Error('E03 producer initial catalog did not admit root and middle meshes');
    if (assets.lookup(lowestGuid) !== undefined)
      throw new Error('E03 producer lowest mesh was present before its catalog stage');
    rootMeshValue = stagedRoot;
    producerInputEvidence = {
      producerHead: String(verified.manifest.provenance.producerHead),
      manifestSha256: verified.sha256,
      shaderPublicationSha256: String(
        (
          verified.manifest.shaderClosure as {
            publication?: { readonly sha256?: unknown };
          }
        ).publication?.sha256,
      ),
      gpuReadiness: 'unverified',
      admission: 'incremental-catalog',
    };
  } else {
    const rootMesh = await assets.loadByGuid<MeshAsset>(rootGuid);
    if (!rootMesh.ok) throw new Error(`root mesh load failed: ${rootMesh.error.code}`);
    const middleMesh = await assets.loadByGuid<MeshAsset>(middleGuid);
    if (!middleMesh.ok) throw new Error(`middle LOD load failed: ${middleMesh.error.code}`);
    rootMeshValue = rootMesh.value;
  }
  const lodReadiness = (): readonly boolean[] => [
    true,
    assets.lookup(middleGuid)?.kind === 'mesh',
    assets.lookup(lowestGuid)?.kind === 'mesh',
  ];
  const lodIndexCounts = (): readonly number[] => [
    rootMeshValue.indices?.length ?? 0,
    ...(rootMeshValue.lods ?? []).map(
      (lod: NonNullable<MeshAsset['lods']>[number]) =>
        assets.lookup<MeshAsset>(lod.mesh)?.indices?.length ?? 0,
    ),
  ];

  // The interactive demo uses the imported MeshAsset and its LOD GUID chain
  // with opaque Standard PBR materials, which is the production GPU-driven
  // LOD lane exercised by the Dawn smoke.
  const meshHandle = world.allocSharedRef('MeshAsset', rootMeshValue);
  const materialHandle = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.08, 0.48, 0.78, 1], roughness: 0.5 }),
  );
  const sphereEntity = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
      { component: Visibility, data: { state: VisibilityStateValue.inherited } },
    )
    .unwrap();
  const viewAspect = target.width / 2 / target.height;
  const nearCameraEntity = spawnCamera(world, 5, [0, 0, 0.5, 1], 0, viewAspect);
  const farCameraEntity = spawnCamera(world, 45, [0.5, 0, 0.5, 1], 1, viewAspect);
  cameraNearId = Number(nearCameraEntity);
  cameraFarId = Number(farCameraEntity);

  const camera = createCameraControls(target, world, nearCameraEntity, 5);
  camera.reset();

  // Imported glTF scene has no light; provide a real render component for Standard.
  // The solid-colour Skylight keeps the side facing away from the sun readable.
  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.5, -1, -0.3], intensity: 2 },
  });
  world.spawn({ component: Skylight, data: { color: [0.75, 0.85, 1], intensity: 0.35 } });

  const attachment = renderer.attach(world);
  if (!attachment.ok) throw attachment.error;
  const frameRequest = {
    leases: [attachment.value],
    camera: { lease: attachment.value },
    environment: { lease: attachment.value },
  };

  const phaseProgress = createLodPhaseProgress();
  let phaseToken = phaseProgress.beginPhase('interactive', Number.MAX_SAFE_INTEGER);
  const frameQueue = createSerialFrameQueue();
  let phaseFrameLimit: number | undefined;
  let frameRunning = true;
  let scheduledFrame: number | undefined;
  let evidenceError: string | undefined;
  let dynamicRevisionFour: import('@forgeax/engine-render').DynamicGeometryCandidate | undefined;
  let revisionRace: Record<string, unknown> | undefined;
  let visible = true;
  const runtimeErrors: string[] = [];
  const scheduleFrame = (): void => {
    if (!frameRunning || scheduledFrame !== undefined) return;
    scheduledFrame = requestAnimationFrame(() => {
      scheduledFrame = undefined;
      void frameQueue
        .enqueue(frame)
        .catch((error: unknown) => {
          runtimeErrors.push(`frame:${String(error)}`);
          console.error('[hello-lod-occlusion] frame failed', error);
        })
        .finally(() => {
          const current = phaseProgress.snapshot();
          if (phaseFrameLimit !== undefined && current.phaseAcceptedFrames >= phaseFrameLimit) {
            frameRunning = false;
          }
          updateAcceptanceStatus();
          scheduleFrame();
        });
    });
  };
  const setVisible = (nextVisible: boolean): void => {
    const result = world.set(sphereEntity, Visibility, {
      state: nextVisible ? VisibilityStateValue.inherited : VisibilityStateValue.hidden,
    });
    if (!result.ok) throw new Error(`visibility update failed: ${result.error.code}`);
    visible = nextVisible;
    const button = document.querySelector<HTMLButtonElement>('#toggle-visibility');
    if (button)
      button.textContent = visible
        ? (button.dataset.visibleLabel ?? 'Hide target')
        : (button.dataset.hiddenLabel ?? 'Show target');
  };
  const acceptance = {
    async beginPhase(nextPhase: string, frameLimit = 60) {
      frameRunning = false;
      if (scheduledFrame !== undefined) {
        cancelAnimationFrame(scheduledFrame);
        scheduledFrame = undefined;
      }
      await frameQueue.drain();
      phaseToken = phaseProgress.beginPhase(nextPhase, frameLimit);
      evidenceError = undefined;
      phaseFrameLimit = frameLimit;
      frameRunning = true;
      scheduleFrame();
      return this.snapshot();
    },
    setVisible,
    setNearDistance: camera.setDistance,
    async loadLowestLod() {
      if (producerAdmission !== undefined) {
        await producerAdmission.admitLowest();
      } else {
        const loaded = await assets.loadByGuid<MeshAsset>(lowestGuid);
        if (!loaded.ok) throw new Error(`lowest LOD load failed: ${loaded.error.code}`);
      }
      if (assets.lookup(lowestGuid)?.kind !== 'mesh')
        throw new Error('lowest LOD catalog admission did not produce a MeshAsset');
      const button = document.querySelector<HTMLButtonElement>('#load-low-lod');
      if (button) button.textContent = button.dataset.loadedLabel ?? 'Lowest LOD loaded';
      return this.snapshot();
    },
    acceptRevisionRace() {
      const lateMesh = structuredClone(rootMeshValue);
      const acceptedMesh = structuredClone(rootMeshValue);
      const lateHandle = world.allocSharedRef('MeshAsset', lateMesh);
      const acceptedHandle = world.allocSharedRef('MeshAsset', acceptedMesh);
      const late = renderer.prepareDynamicGeometry({
        world,
        entity: sphereEntity,
        mesh: lateMesh,
        meshHandle: lateHandle,
        revision: 3,
        topologyRevision: 1,
        fixedStep: 0,
      });
      if (!late.ok) {
        world.sharedRefs.release(lateHandle).unwrap();
        world.sharedRefs.release(acceptedHandle).unwrap();
        throw new Error(`revision 3 preparation failed: ${late.error.code}`);
      }
      const accepted = renderer.prepareDynamicGeometry({
        world,
        entity: sphereEntity,
        mesh: acceptedMesh,
        meshHandle: acceptedHandle,
        revision: 4,
        topologyRevision: 1,
        fixedStep: 0,
      });
      if (!accepted.ok) {
        renderer.cancelDynamicGeometry(late.value).unwrap();
        world.sharedRefs.release(lateHandle).unwrap();
        world.sharedRefs.release(acceptedHandle).unwrap();
        throw new Error(`revision 4 preparation failed: ${accepted.error.code}`);
      }
      const acceptedResult = renderer.acceptDynamicGeometry(accepted.value, {
        world,
        fixedStep: 0,
      });
      if (!acceptedResult.ok) {
        renderer.cancelDynamicGeometry(late.value).unwrap();
        renderer.cancelDynamicGeometry(accepted.value).unwrap();
        world.sharedRefs.release(lateHandle).unwrap();
        world.sharedRefs.release(acceptedHandle).unwrap();
        throw new Error(`revision 4 acceptance failed: ${acceptedResult.error.code}`);
      }
      world.sharedRefs.release(acceptedHandle).unwrap();
      const lateResult = renderer.acceptDynamicGeometry(late.value, { world, fixedStep: 0 });
      const binding = world.get(sphereEntity, MeshFilter).unwrap().assetHandle;
      // Accepting revision 4 already cancels the superseded prepared credential.
      world.sharedRefs.release(lateHandle).unwrap();
      if (lateResult.ok || lateResult.error.code !== 'dynamic-geometry-candidate-not-found') {
        renderer.cancelDynamicGeometry(acceptedResult.value).unwrap();
        throw new Error(
          `superseded revision 3 credential was not rejected: ${lateResult.ok ? 'accepted' : lateResult.error.code}`,
        );
      }
      if (binding !== acceptedResult.value.meshHandle) {
        renderer.cancelDynamicGeometry(acceptedResult.value).unwrap();
        throw new Error('accepted revision 4 MeshFilter binding changed after late revision 3');
      }
      dynamicRevisionFour = acceptedResult.value;
      revisionRace = {
        acceptedRevision: acceptedResult.value.revision,
        lateRevision: late.value.revision,
        lateError: lateResult.error.code,
        bindingHandle: binding,
      };
      return this.snapshot();
    },
    snapshot() {
      const progress = phaseProgress.snapshot();
      const summary = progress.latestEvidence;
      const evidenceReceipt = summary?.submit;
      const dynamicReceipt =
        dynamicRevisionFour === undefined
          ? undefined
          : renderer.dynamicGeometryReceipt(dynamicRevisionFour);
      return {
        phase: progress.phase,
        phaseCompletedFrames: progress.phaseCompletedFrames,
        phaseAcceptedFrames: progress.phaseAcceptedFrames,
        totalCompletedFrames: progress.totalCompletedFrames,
        totalAcceptedFrames: progress.totalAcceptedFrames,
        latestReceipt: progress.latestReceipt,
        evidenceReceipt:
          evidenceReceipt === undefined
            ? undefined
            : {
                frameId: evidenceReceipt.frameId,
                deviceGeneration: evidenceReceipt.deviceGeneration,
              },
        evidenceError,
        submit: summary?.submit,
        sameSubmitAttribution: summary?.attribution,
        attachmentId: summary?.attachmentId,
        aggregate: summary && 'aggregate' in summary ? summary.aggregate : undefined,
        hiddenDraws: summary && 'draws' in summary ? summary.draws : undefined,
        hiddenLodObservation:
          summary && 'lodObservation' in summary ? summary.lodObservation : undefined,
        views: summary?.cameraViews ?? [],
        nearCameraEntity: Number(nearCameraEntity),
        farCameraEntity: Number(farCameraEntity),
        lodAssetsReady: lodReadiness(),
        targetVisible: visible,
        producerInput: producerInputEvidence,
        rootMeshSharedRefCount: world.sharedRefs.refcount(meshHandle),
        revisionRace,
        dynamicReceipt,
        dynamicRevisionBindingHandle: dynamicRevisionFour?.meshHandle,
        runtimeErrors: [...runtimeErrors],
      };
    },
  };
  (globalThis as unknown as { __forgeaxLodAcceptance: typeof acceptance }).__forgeaxLodAcceptance =
    acceptance;
  document.querySelector<HTMLButtonElement>('#toggle-visibility')?.addEventListener('click', () => {
    try {
      setVisible(!visible);
    } catch (error) {
      console.error('[hello-lod-occlusion] visibility update failed', error);
    }
  });
  document.querySelector<HTMLButtonElement>('#load-low-lod')?.addEventListener('click', () => {
    void acceptance
      .loadLowestLod()
      .then(() => {
        const button = document.querySelector<HTMLButtonElement>('#load-low-lod');
        if (button) button.textContent = button.dataset.loadedLabel ?? 'Lowest LOD loaded';
      })
      .catch((error: unknown) =>
        console.error('[hello-lod-occlusion] lowest LOD load failed', error),
      );
  });
  document
    .querySelector<HTMLButtonElement>('#accept-revision-race')
    ?.addEventListener('click', () => {
      try {
        acceptance.acceptRevisionRace();
      } catch (error) {
        console.error('[hello-lod-occlusion] revision race failed', error);
      }
    });
  const updateAcceptanceStatus = (): void => {
    if (!status) return;
    const progress = phaseProgress.snapshot();
    status.textContent = JSON.stringify(
      {
        asset: 'lod-scene.gltf',
        sceneGuid: AssetGuid.format(sceneGuid),
        completedFrames: progress.totalCompletedFrames,
        acceptedEvidenceFrames: progress.totalAcceptedFrames,
        acceptance: acceptance.snapshot(),
      },
      null,
      2,
    );
  };
  const frame = async (): Promise<void> => {
    void worldContext;
    const drawPhase = phaseToken;
    world.update().unwrap();
    const drawn = renderer.draw(frameRequest);
    if (!drawn.ok) {
      runtimeErrors.push(`draw:${drawn.error.code}`);
      evidenceError = `draw failed: ${drawn.error.code}`;
      console.error('[hello-lod-occlusion] draw failed', drawn.error);
    }
    if (drawn.ok) {
      const receipt = drawn.value;
      const result = await observeCompletedReceipt(
        receipt,
        (exactReceipt) => renderer.observe(exactReceipt, { include: ['lod-occlusion', 'draws'] }),
        (exactReceipt) => phaseProgress.markCompleted(drawPhase, exactReceipt),
      );
      if (result.status === 'completion-failed') {
        const code = resultErrorCode(result.error);
        runtimeErrors.push(`complete:${code}`);
        evidenceError = `frame completion failed: ${code}`;
        console.error('[hello-lod-occlusion] frame completion failed', result.error);
      } else {
        const completion = result.completion;
        if (result.status === 'observation-failed') {
          const code = resultErrorCode(result.error);
          runtimeErrors.push(`observe:${code}`);
          console.error('[hello-lod-occlusion] observe failed', result.error);
          evidenceError = `receipt observation failed: ${code}`;
        } else {
          try {
            const cameraIds = [Number(nearCameraEntity), Number(farCameraEntity)];
            const evidence =
              world.get(sphereEntity, Visibility).unwrap().state === VisibilityStateValue.hidden
                ? summarizeHiddenObservation(result.value, receipt, cameraIds, world.identity)
                : summarizeLodObservation(
                    result.value,
                    receipt,
                    cameraIds,
                    world.get(sphereEntity, MeshFilter).unwrap().assetHandle,
                  );
            if (!phaseProgress.accept(drawPhase, completion, evidence)) {
              evidenceError = 'receipt evidence was duplicate, stale, or belonged to an old phase';
            } else {
              evidenceError = undefined;
            }
          } catch (error) {
            evidenceError = error instanceof Error ? error.message : String(error);
          }
        }
      }
    }
    const sample = acceptance.snapshot();
    if (sample.evidenceReceipt !== undefined) {
      const evidence = phaseProgress.snapshot().latestEvidence;
      updateLodHud(
        evidence && 'aggregate' in evidence ? evidence.cameraViews : [],
        camera.snapshot(),
        lodIndexCounts(),
        sample.lodAssetsReady,
      );
    }
    updateAcceptanceStatus();
  };
  scheduleFrame();
}

function spawnCamera(
  world: World,
  distance: number,
  viewport: readonly [number, number, number, number],
  order: number,
  aspect: number,
): EntityHandle {
  return world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, distance], quat: new Float32Array([0, 0, 0, 1]) },
      },
      { component: Camera, data: { fov: Math.PI / 4, aspect, near: 0.1, far: 100 } },
      { component: CameraView, data: { viewport, order } },
    )
    .unwrap();
}

function updateLodHud(
  rows: readonly import('../scripts/lod-acceptance-evidence.mjs').LodCameraEvidence[],
  camera: { readonly distance: number },
  lodIndexCounts: readonly number[],
  lodAssetsReady: readonly boolean[],
): void {
  const near = rows.find((row) => row.cameraEntity === cameraNearId);
  const far = rows.find((row) => row.cameraEntity === cameraFarId);
  const nearLevel = selectedLod(near);
  const farLevel = selectedLod(far);
  if (lodLevel) lodLevel.textContent = `Near LOD${nearLevel ?? '--'} · Far LOD${farLevel ?? '--'}`;
  const triangleCount = Math.floor((lodIndexCounts[nearLevel ?? 0] ?? 0) / 3);
  if (lodGeometry) {
    lodGeometry.textContent = `Near view ${triangleCount} triangles · ${visibleLabel(lodAssetsReady)}`;
  }
  if (lodDetail) {
    lodDetail.textContent = `Near distance ${camera.distance}m · visible ${near?.count?.visible ?? 0} / ${far?.count?.visible ?? 0}`;
  }
  if (multiViewDetail) {
    const farFallback =
      farLevel === 1 && !lodAssetsReady[2] ? ' (LOD2 pending; finer fallback)' : '';
    multiViewDetail.textContent = `CameraView left ${nearLevel ?? 'none'} / right ${farLevel ?? 'none'}${farFallback}`;
  }
}

function visibleLabel(lodAssetsReady: readonly boolean[]): string {
  return lodAssetsReady[2] ? 'LOD2 ready' : 'LOD2 waiting to load';
}

function resultErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { readonly code: unknown }).code);
  }
  return String(error);
}

let cameraNearId = -1;
let cameraFarId = -1;

interface CameraControls {
  readonly reset: () => void;
  readonly setDistance: (nextDistance: number) => void;
  readonly snapshot: () => { readonly distance: number };
}

function createCameraControls(
  target: HTMLCanvasElement,
  world: World,
  entity: EntityHandle,
  initialDistance = 20,
): CameraControls {
  const minDistance = 2.5;
  const maxDistance = 60;
  let distance = initialDistance;

  const apply = (): void => {
    const result = world.set(entity, Transform, { pos: [0, 0, distance] });
    if (!result.ok) console.error('[hello-lod-occlusion] camera update failed', result.error);
  };

  const reset = (): void => {
    distance = initialDistance;
    apply();
  };

  const setDistance = (nextDistance: number): void => {
    if (!Number.isFinite(nextDistance)) return;
    distance = Math.min(maxDistance, Math.max(minDistance, nextDistance));
    apply();
  };

  const zoom = (delta: number): void => {
    distance = Math.min(maxDistance, Math.max(minDistance, distance * Math.exp(delta * 0.0015)));
    apply();
  };

  target.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoom(event.deltaY);
    },
    { passive: false },
  );
  for (const button of target.ownerDocument.querySelectorAll<HTMLButtonElement>(
    '[data-distance]',
  )) {
    const preset = Number(button.dataset.distance);
    if (!Number.isFinite(preset)) continue;
    button.addEventListener('click', () => setDistance(preset));
  }
  target.addEventListener('keydown', (event) => {
    const presetDistance =
      event.key === '1' ? 5 : event.key === '2' ? 20 : event.key === '3' ? 45 : undefined;
    if (presetDistance !== undefined) {
      event.preventDefault();
      setDistance(presetDistance);
      return;
    }
    if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      reset();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoom(-120);
      return;
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoom(120);
      return;
    }
  });

  return {
    reset,
    setDistance,
    snapshot: () => ({ distance: Number(distance.toFixed(2)) }),
  };
}

function findGuid(kind: string): AssetGuid {
  const entry = (lodMeta.subAssets as readonly SubAssetEntry[]).find(
    (candidate) => candidate.kind === kind,
  );
  if (entry === undefined) throw new Error(`LOD sidecar has no ${kind} GUID`);
  const parsed = AssetGuid.parse(entry.guid);
  if (!parsed.ok) throw new Error(`invalid ${kind} GUID: ${parsed.error.code}`);
  return parsed.value;
}

function guidAt(
  entries: readonly (SubAssetEntry & { readonly sourceIndex?: number })[],
  sourceIndex: number,
): AssetGuid {
  const entry = entries.find((candidate) => candidate.sourceIndex === sourceIndex);
  if (entry === undefined) throw new Error(`LOD sidecar has no mesh source index ${sourceIndex}`);
  const parsed = AssetGuid.parse(entry.guid);
  if (!parsed.ok) throw new Error(`invalid mesh GUID: ${parsed.error.code}`);
  return parsed.value;
}
