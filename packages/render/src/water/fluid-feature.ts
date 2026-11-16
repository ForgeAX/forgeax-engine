import { Time, type World } from '@forgeax/engine-ecs';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import { PhysicsWorldResource } from '@forgeax/engine-physics';
import { err, ok, type TextureAsset } from '@forgeax/engine-types';
import {
  prepareWaterFluidFrame,
  WATER_BUOYANCY_RESOURCE,
  WATER_SYSTEM_RESOURCE,
  WATER_VISUAL_CONTACTS_RESOURCE,
  type WaterBuoyancyState,
  type WaterDependencySnapshot,
  type WaterFluidFrame,
  type WaterSplashWakeEvent,
  type WaterSystem,
  type WaterVisualContactState,
  type WaterWaveUploadBody,
  waterBodyOwnerKey,
} from '@forgeax/engine-water';
import { RenderFeatureStageFailedError } from '../errors/render';
import type { RenderFeaturePlan, RenderFeaturePlanContext } from '../features/plan';
import { captureFeatureSourceAssetVersion } from '../features/source';
import type { RenderFeature } from '../features/types';
import { worldRenderResources } from '../publication/resource-scope';
import type { WaterAdvancedShallowFoamSource } from './advanced-feature';

export { WATER_ADVANCED_FEATURE_IDENTITY } from './advanced-feature';

import {
  prepareWaterFluidFoamFrame,
  WATER_FLUID_FOAM_EVENT_CAPACITY,
  WATER_FLUID_FOAM_EVENT_STRIDE_BYTES,
  type WaterFluidFoamEvent,
  type WaterFluidFoamFrame,
  type WaterFluidFoamInput,
  type WaterFluidFoamOptions,
  type WaterFluidFoamOwner,
  type WaterFluidFoamRoot,
  waterFluidFoamEventCurrent,
  waterFluidFoamEventKey,
  waterFluidFoamOwnerKey,
  waterFluidFoamRootKey,
} from './fluid-foam';
import { waterInfoFramePublicationForRenderer } from './water-info-feature';
import type {
  WaterInfoDescriptorRow,
  WaterInfoFramePublication,
} from './water-info-publication-work';

export const WATER_FLUID_FEATURE_IDENTITY = 'water-fluid-simulation';
type FluidSourceBlocker = {
  readonly worldIndex: number;
  readonly bodyGuid: string;
  readonly bodyGeneration: number;
  readonly field: 'body' | 'waveSetGuid' | 'impulseNoiseGuid';
  readonly guid: string;
} & (
  | { readonly status: 'pending' | 'unavailable' | 'invalid-kind'; readonly actualKind?: string }
  | {
      readonly status: 'failed';
      readonly failure: Extract<WaterDependencySnapshot, { readonly status: 'failed' }>['failure'];
    }
);
export interface WaterFluidFeatureFrame {
  readonly kind: 'forgeax-water-fluid-frame';
  readonly sourceFrame: number;
  readonly simulations: readonly {
    readonly worldIndex: number;
    readonly worldIdentity: World['identity'];
    readonly frame: WaterFluidFrame;
    readonly impulseNoise?: {
      readonly handle: number;
      readonly revision: number;
      readonly asset: TextureAsset;
    };
  }[];
  readonly sourceBlockers: readonly FluidSourceBlocker[];
  readonly contactFoam?: Omit<WaterFluidFoamInput, 'timeSeconds'> & {
    readonly worldTimes: readonly Readonly<{ worldIdentity: string; timeSeconds: number }>[];
  };
  readonly contactFoamBodies?: readonly WaterFluidFoamOwner[];
  readonly shallowFoamSources?: readonly WaterAdvancedShallowFoamSource[];
  readonly inspection: unknown;
}
export interface WaterFluidRenderFrame {
  readonly token: string;
  readonly simulations: WaterFluidFeatureFrame['simulations'];
  readonly waterInfoViewIdentity: string | undefined;
  readonly frameNumber: number;
  readonly deviceGeneration: number;
  readonly contactFoam?: WaterFluidFoamFrame;
  readonly shallowFoamSources?: readonly WaterAdvancedShallowFoamSource[];
  readonly encoded: Set<string>;
  readonly required: Set<string>;
}
export const waterFluidSimulationKey = (
  entry: Pick<WaterFluidFeatureFrame['simulations'][number], 'worldIdentity' | 'frame'>,
): string => JSON.stringify([entry.worldIdentity, entry.frame.instance.instanceId]);
const pendingFrames = new WeakMap<object, WaterFluidRenderFrame>();

function waveSourceBlocker(
  system: WaterSystem,
  worldIndex: number,
  frame: WaterFluidFrame,
): FluidSourceBlocker | undefined {
  if (!frame.instance.recipe.foamEnabled) return;
  const body = system.snapshot(frame.instance.bodyGuid);
  const reference = {
    worldIndex,
    bodyGuid: frame.instance.bodyGuid,
    bodyGeneration: frame.instance.bodyGeneration,
  };
  if (body === undefined || body.sceneGeneration !== frame.instance.bodyGeneration)
    return { ...reference, field: 'body', guid: frame.instance.bodyGuid, status: 'unavailable' };
  if (body.asset.type === 'river' || body.asset.waveSetGuid === undefined) return;
  const guid = body.asset.waveSetGuid;
  const dependency = body.dependencies.find(
    (item) => item.field === 'waveSetGuid' && item.guid === guid,
  );
  const input = { ...reference, field: 'waveSetGuid' as const, guid };
  switch (dependency?.status) {
    case 'valid':
      return;
    case 'pending':
      return { ...input, status: 'pending' };
    case 'unavailable':
    case undefined:
      return { ...input, status: 'unavailable' };
    case 'invalid-kind':
      return {
        ...input,
        status: 'invalid-kind',
        ...(dependency.actualKind === undefined ? {} : { actualKind: dependency.actualKind }),
      };
    case 'failed':
      return { ...input, status: 'failed', failure: dependency.failure };
  }
}
export function waterFluidRenderFrame(
  features: readonly RenderFeature<unknown>[] | undefined,
): WaterFluidRenderFrame | undefined {
  const feature = features?.find((item) => item.identity === WATER_FLUID_FEATURE_IDENTITY);
  return feature === undefined ? undefined : pendingFrames.get(feature);
}
interface FluidFeedback {
  kind: 'water-fluid-submitted';
  sourceFrame: number;
  submitted: WaterFluidFeatureFrame['simulations'][number][];
  contactFoam?: WaterFluidFoamFrame;
}

export interface WaterFluidFeatureOptions {
  readonly contactFoam?: WaterFluidFoamOptions;
}

function fluidWaterInfoRowMatches(
  row: WaterInfoDescriptorRow,
  target: WaterInfoFramePublication['targets'][number] | undefined,
  entry: WaterFluidFeatureFrame['simulations'][number],
  body: WaterWaveUploadBody,
  frameGeneration: number,
  deviceGeneration: number,
): boolean {
  return !(
    row.worldIdentity !== entry.worldIdentity ||
    row.worldId !== entry.worldIndex ||
    row.bodyGuid !== body.bodyGuid ||
    row.bodyGeneration !== body.bodyGeneration ||
    row.zoneGeneration !== body.zoneGeneration ||
    row.frameGeneration !== frameGeneration ||
    row.deviceGeneration !== deviceGeneration ||
    target === undefined ||
    row.slice < 0 ||
    row.slice >= target.layers
  );
}

function fluidWaterInfoReadiness(
  owner: object,
  data: WaterFluidFeatureFrame,
  context: RenderFeaturePlanContext,
) {
  const viewIdentity = context.views.find((view) => view.render)?.identity;
  const frameGeneration = context.frame.frameNumber;
  const deviceGeneration = context.deviceGeneration ?? 0;
  const publication =
    viewIdentity === undefined
      ? undefined
      : waterInfoFramePublicationForRenderer(
          owner,
          viewIdentity,
          frameGeneration,
          deviceGeneration,
        );
  let pending: RenderFeaturePlan['pendingSource'];
  for (const entry of data.simulations) {
    if (entry.frame.instance.recipe.terrainMode !== 'water-info') continue;
    const reference = {
      worldIndex: entry.worldIndex,
      worldIdentity: entry.worldIdentity,
      bodyGuid: entry.frame.instance.bodyGuid,
      bodyGeneration: entry.frame.instance.bodyGeneration,
      viewIdentity,
      frameGeneration,
      deviceGeneration,
    };
    const fail = (detail?: unknown) =>
      err(
        new RenderFeatureStageFailedError(WATER_FLUID_FEATURE_IDENTITY, -1, 'plan', 'next-frame', {
          expected:
            'the exact same-frame, same-World WaterInfo closure for the accepted fluid Body generation',
          ...reference,
          detail,
        }),
      );
    if (
      publication === undefined ||
      publication.viewIdentity !== viewIdentity ||
      publication.frameGeneration !== frameGeneration ||
      publication.deviceGeneration !== deviceGeneration
    )
      return fail();
    const body = publication.waveBodies.find(
      (body) =>
        body.worldIdentity === entry.worldIdentity &&
        body.worldId === entry.worldIndex &&
        body.bodyGuid === reference.bodyGuid &&
        body.bodyGeneration === reference.bodyGeneration,
    );
    if (body === undefined) return fail();
    const key = waterBodyOwnerKey(
      entry.worldIdentity,
      body.bodyGuid,
      body.bodyGeneration,
      body.zoneGeneration,
    );
    const row = publication.rows.get(key);
    if (row === undefined) {
      const availability = publication.waterInfoAvailability.get(key);
      if (availability?.kind === 'pending') {
        pending ??= { resource: availability.guid, reason: 'asset-dependency-pending' };
        continue;
      }
      return fail(availability);
    }
    const target = publication.targets.find(
      (target) => target.targetName === row.targetName && target.targetFormat === row.targetFormat,
    );
    if (!fluidWaterInfoRowMatches(row, target, entry, body, frameGeneration, deviceGeneration))
      return fail();
  }
  return ok(pending);
}

function contactEvent(worldIdentity: string, event: WaterSplashWakeEvent): WaterFluidFoamEvent {
  const vector = (value: readonly [number, number, number]) =>
    Object.freeze([...value] as [number, number, number]);
  return Object.freeze({
    worldIdentity,
    event: Object.freeze({
      ...event,
      positionM: vector(event.positionM),
      forceN: vector(event.forceN),
      contact: Object.freeze(
        event.contact.kind === 'none'
          ? { ...event.contact }
          : {
              ...event.contact,
              positionM: vector(event.contact.positionM),
              relativeVelocityMps: vector(event.contact.relativeVelocityMps),
            },
      ),
    }),
  });
}

/** The feature holds source acknowledgments; Standard owns the WaterInfo-dependent graph. */
export function createWaterFluidFeature(
  options: WaterFluidFeatureOptions = {},
  waterInfoFeature?: object,
): RenderFeature<WaterFluidFeatureFrame> {
  const inactiveSourceData: WaterFluidFeatureFrame = Object.freeze({
    kind: 'forgeax-water-fluid-frame',
    sourceFrame: 0,
    simulations: Object.freeze([]),
    sourceBlockers: Object.freeze([]),
    inspection: Object.freeze([]),
  });
  const foamOptions =
    options.contactFoam === undefined ? undefined : Object.freeze({ ...options.contactFoam });
  const queuedFoamEvents = new Map<string, WaterFluidFoamEvent>();
  const acknowledgedFoamCursors = new Map<string, number>();
  let submittedFoam: WaterFluidFoamFrame | undefined;
  const worlds = new WeakMap<WaterFluidFeatureFrame, readonly World[]>();
  const reporters = new WeakMap<
    WaterFluidFeatureFrame,
    import('../features/types').RenderFeatureExtractContext['reportError']
  >();
  let serial = 0;
  const candidates = new WeakMap<
    WaterFluidFeatureFrame,
    { render: WaterFluidRenderFrame; feedback: FluidFeedback }
  >();
  const submitted = new Map<string, WaterFluidFrame>();
  const commit = (
    data: WaterFluidFeatureFrame,
    snapshots: WaterFluidFeatureFrame['simulations'],
  ) => {
    for (const { worldIndex, worldIdentity, frame } of snapshots) {
      const world = worlds.get(data)?.[worldIndex];
      if (world?.identity !== worldIdentity || !world.hasResource(WATER_SYSTEM_RESOURCE)) continue;
      const accepted = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE).fluid.submit(frame);
      if (!accepted.ok)
        reporters.get(data)?.(
          new RenderFeatureStageFailedError(
            WATER_FLUID_FEATURE_IDENTITY,
            -1,
            'record',
            'next-frame',
            { expected: accepted.error.expected, detail: accepted.error },
          ),
        );
    }
  };
  const feature: RenderFeature<WaterFluidFeatureFrame> = {
    identity: WATER_FLUID_FEATURE_IDENTITY,
    inactiveSourceData,
    placement: 'scene',
    extract(context) {
      pendingFrames.delete(feature);
      const simulations: WaterFluidFeatureFrame['simulations'][number][] = [];
      const sourceBlockers: FluidSourceBlocker[] = [];
      const inspection: unknown[] = [];
      const foamRoots: WaterFluidFoamRoot[] = [];
      const foamBodies: WaterFluidFoamOwner[] = [];
      const shallowFoamSources: WaterAdvancedShallowFoamSource[] = [];
      const foamTimes = new Map<string, number>();
      for (let worldIndex = 0; worldIndex < [context.world].length; worldIndex++) {
        const world = context.world;
        if (world === undefined || !world.hasResource(WATER_SYSTEM_RESOURCE)) continue;
        const system = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
        const timeSeconds = world.getResource(Time).elapsed;
        const captureContactFoam = () => {
          if (foamOptions !== undefined) {
            foamTimes.set(world.identity, timeSeconds);
            foamBodies.push(
              ...system
                .snapshots()
                .filter((body) => body.asset.type === 'ocean')
                .map((body) =>
                  Object.freeze({
                    worldIdentity: world.identity,
                    bodyGuid: body.guid,
                    bodyGeneration: body.sceneGeneration,
                  }),
                ),
            );
            const viewIdentity = context.views.find((view) => view.render)?.identity;
            for (const simulation of system.advancedSimulations()) {
              const inspection = simulation.inspect();
              const body = system.snapshot(simulation.body.guid);
              if (
                viewIdentity === undefined ||
                inspection.status === 'disabled' ||
                inspection.status === 'retired' ||
                !simulation.recipe.asset.enabledFeatures.includes('shallowFoam') ||
                body?.asset.type !== 'ocean' ||
                body.sceneGeneration !== simulation.body.generation
              )
                continue;
              shallowFoamSources.push(
                Object.freeze({
                  worldIdentity: world.identity,
                  bodyGuid: simulation.body.guid,
                  bodyGeneration: simulation.body.generation,
                  recipeGuid: simulation.recipe.guid,
                  simulationGeneration: inspection.generation,
                  viewIdentity,
                }),
              );
            }
            const physics = world.hasResource(PhysicsWorldResource)
              ? world.getResource<PhysicsWorld>(PhysicsWorldResource)
              : undefined;
            const explicitContacts = new Set<string>();
            const captureVisualContacts = () => {
              if (world.hasResource(WATER_VISUAL_CONTACTS_RESOURCE)) {
                const visual = world.getResource<WaterVisualContactState>(
                  WATER_VISUAL_CONTACTS_RESOURCE,
                );
                for (const root of visual.roots)
                  explicitContacts.add(JSON.stringify([root.rootEntity, root.rootGeneration]));
                foamRoots.push(
                  ...visual.roots.map((root) =>
                    Object.freeze({ ...root, worldIdentity: world.identity }),
                  ),
                );
                for (const event of visual.contacts) {
                  const entry = Object.freeze({ worldIdentity: world.identity, event });
                  const root = waterFluidFoamRootKey({ ...event, worldIdentity: world.identity });
                  if (event.sourcePhysicsStep <= (acknowledgedFoamCursors.get(root) ?? -1))
                    continue;
                  // A visual probe publishes continuous contact state. Keep its
                  // latest unacknowledged sample while GPU preparation is pending;
                  // frozen source frames still retain their original event rows.
                  const key = JSON.stringify([
                    root,
                    event.probeId,
                    event.bodyGuid,
                    event.bodyGeneration,
                  ]);
                  const previous = queuedFoamEvents.get(key);
                  if (previous && previous.event.sourcePhysicsStep > event.sourcePhysicsStep)
                    continue;
                  if (
                    queuedFoamEvents.size < WATER_FLUID_FOAM_EVENT_CAPACITY ||
                    queuedFoamEvents.has(key)
                  )
                    queuedFoamEvents.set(key, entry);
                  else
                    context.reportError?.(
                      new RenderFeatureStageFailedError(
                        WATER_FLUID_FEATURE_IDENTITY,
                        -1,
                        'extract',
                        'next-frame',
                        {
                          expected:
                            'at most 4096 pending contact events before source acknowledgement',
                          reason: 'contact-event-queue-full',
                          detail: { maximum: 4096, refusedEvent: key },
                        },
                      ),
                    );
                }
              }
            };
            captureVisualContacts();
            const buoyancy = world.hasResource(WATER_BUOYANCY_RESOURCE)
              ? world.getResource<WaterBuoyancyState>(WATER_BUOYANCY_RESOURCE)
              : undefined;
            const captureBuoyancyRoots = () => {
              for (const row of buoyancy?.steps ?? []) {
                const step = row.result.ok ? row.result.value : undefined;
                if (step === undefined) continue;
                if (explicitContacts.has(JSON.stringify([step.rootEntity, step.rootGeneration])))
                  continue;
                const dynamics = physics?.getCommittedBodyDynamics?.(step.rootEntity);
                if (dynamics?.ok && dynamics.value.generation === step.rootGeneration)
                  foamRoots.push(
                    Object.freeze({
                      worldIdentity: world.identity,
                      rootEntity: step.rootEntity,
                      rootGeneration: step.rootGeneration,
                    }),
                  );
              }
            };
            captureBuoyancyRoots();
            const captureBuoyancyContacts = () => {
              for (const event of buoyancy?.splashWakeEvents ?? []) {
                // Explicit hull geometry owns contact appearance. Pontoons remain
                // force samples and only supply foam proxies when no probes exist.
                if (explicitContacts.has(JSON.stringify([event.rootEntity, event.rootGeneration])))
                  continue;
                const dynamics = physics?.getCommittedBodyDynamics?.(event.rootEntity);
                if (
                  !dynamics?.ok ||
                  dynamics.value.generation !== event.rootGeneration ||
                  dynamics.value.completedStep < event.sourcePhysicsStep
                )
                  continue;
                const body =
                  event.bodyGuid === undefined ? undefined : system.snapshot(event.bodyGuid);
                if (body?.asset.type !== 'ocean' || body.sceneGeneration !== event.bodyGeneration)
                  continue;
                const entry = contactEvent(world.identity, event);
                const root = waterFluidFoamRootKey({ ...event, worldIdentity: world.identity });
                const key = waterFluidFoamEventKey(entry);
                if (
                  event.sourcePhysicsStep > (acknowledgedFoamCursors.get(root) ?? -1) &&
                  waterFluidFoamEventCurrent(
                    event.queryTimeSeconds,
                    timeSeconds,
                    foamOptions.maximumEventAgeSeconds,
                  )
                ) {
                  if (
                    queuedFoamEvents.size < WATER_FLUID_FOAM_EVENT_CAPACITY ||
                    queuedFoamEvents.has(key)
                  )
                    queuedFoamEvents.set(key, entry);
                  else
                    context.reportError?.(
                      new RenderFeatureStageFailedError(
                        WATER_FLUID_FEATURE_IDENTITY,
                        -1,
                        'extract',
                        'next-frame',
                        {
                          expected:
                            'at most 4096 pending contact events before source acknowledgement',
                          reason: 'contact-event-queue-full',
                          detail: { maximum: 4096, refusedEvent: key },
                        },
                      ),
                    );
                }
              }
            };
            captureBuoyancyContacts();
          }
        };
        captureContactFoam();
        const fluid = system.fluid;
        const prepared = fluid.prepare(
          timeSeconds,
          context.views[0]?.frame?.view?.deviceGeneration ?? 0,
          context.frameNumber,
          context.receiverSession,
        );
        if (!prepared.ok)
          return err(
            new RenderFeatureStageFailedError(
              WATER_FLUID_FEATURE_IDENTITY,
              -1,
              'extract',
              'next-frame',
              { expected: prepared.error.expected, detail: prepared.error },
            ),
          );
        const captureFluidSimulationSources = () => {
          for (const frame of prepared.value) {
            const dependency = frame.instance.impulseNoiseDependency;
            const reference = {
              worldIndex,
              bodyGuid: frame.instance.bodyGuid,
              bodyGeneration: frame.instance.bodyGeneration,
              field: 'impulseNoiseGuid' as const,
              guid: frame.instance.recipe.impulseNoiseGuid,
            };
            let impulseNoise: WaterFluidFeatureFrame['simulations'][number]['impulseNoise'];
            if (dependency.status === 'failed')
              sourceBlockers.push({ ...reference, status: 'failed', failure: dependency.failure });
            else if (dependency.status !== 'valid')
              sourceBlockers.push({
                ...reference,
                status: dependency.status,
                ...(dependency.actualKind === undefined
                  ? {}
                  : { actualKind: dependency.actualKind }),
              });
            else {
              const scope = worldRenderResources(world);
              const handle = scope.handleForGuid(reference.guid);
              const captured =
                handle === undefined
                  ? undefined
                  : captureFeatureSourceAssetVersion(context, handle);
              const revision = captured?.ok
                ? captured.value.revision
                : handle === undefined
                  ? undefined
                  : scope.assetRevision(handle);
              const resolved =
                captured !== undefined
                  ? captured.ok
                    ? ok(captured.value.value)
                    : undefined
                  : handle === undefined || revision === undefined
                    ? undefined
                    : scope.resolveAsset(handle, revision);
              if (
                handle !== undefined &&
                revision !== undefined &&
                resolved?.ok &&
                resolved.value.kind === 'texture'
              )
                impulseNoise = { handle, revision, asset: resolved.value };
              else sourceBlockers.push({ ...reference, status: 'unavailable' });
            }
            simulations.push({
              worldIndex,
              worldIdentity: world.identity,
              frame,
              ...(impulseNoise === undefined ? {} : { impulseNoise }),
            });
            const blocker = waveSourceBlocker(system, worldIndex, frame);
            if (blocker !== undefined) sourceBlockers.push(blocker);
          }
        };
        captureFluidSimulationSources();
        inspection.push({ worldIndex, instances: fluid.inspect() });
      }
      const pruneContactFoam = () => {
        const liveRoots = new Set(foamRoots.map(waterFluidFoamRootKey));
        const liveBodies = new Set(foamBodies.map(waterFluidFoamOwnerKey));
        for (const root of acknowledgedFoamCursors.keys())
          if (!liveRoots.has(root)) acknowledgedFoamCursors.delete(root);
        for (const [key, entry] of queuedFoamEvents) {
          const event = entry.event;
          const root = waterFluidFoamRootKey({ ...event, worldIdentity: entry.worldIdentity });
          const body =
            event.bodyGuid === undefined || event.bodyGeneration === undefined
              ? undefined
              : waterFluidFoamOwnerKey({
                  worldIdentity: entry.worldIdentity,
                  bodyGuid: event.bodyGuid,
                  bodyGeneration: event.bodyGeneration,
                });
          if (
            !liveRoots.has(root) ||
            body === undefined ||
            !liveBodies.has(body) ||
            !waterFluidFoamEventCurrent(
              event.queryTimeSeconds,
              foamTimes.get(entry.worldIdentity) ?? Infinity,
              foamOptions?.maximumEventAgeSeconds,
            )
          )
            queuedFoamEvents.delete(key);
        }
      };
      pruneContactFoam();
      if (!context.world.hasResource(WATER_SYSTEM_RESOURCE)) return ok(inactiveSourceData);
      const data: WaterFluidFeatureFrame = {
        kind: 'forgeax-water-fluid-frame',
        sourceFrame: context.frameNumber,
        simulations,
        sourceBlockers,
        inspection,
        ...(foamOptions === undefined
          ? {}
          : {
              contactFoam: Object.freeze({
                ...(context.receiverSession === undefined
                  ? {}
                  : { receiverSession: context.receiverSession }),
                worldTimes: Object.freeze(
                  [...foamTimes].map(([worldIdentity, timeSeconds]) =>
                    Object.freeze({ worldIdentity, timeSeconds }),
                  ),
                ),
                materials: Object.freeze(
                  context.views
                    .filter((view) => view.render)
                    .flatMap((view) => view.frame?.waterFoamMaterials ?? []),
                ),
                roots: Object.freeze(foamRoots),
                events: Object.freeze([...queuedFoamEvents.values()]),
              }),
              contactFoamBodies: Object.freeze(foamBodies),
              shallowFoamSources: Object.freeze(shallowFoamSources),
            }),
      };
      worlds.set(data, [...[context.world]]);
      reporters.set(data, context.reportError);
      return ok(data);
    },
    requiresPreparation: (data) =>
      data.simulations.length > 0 || (data.contactFoamBodies?.length ?? 0) > 0,
    assetDependencies: (data) =>
      data.simulations.flatMap((entry) =>
        entry.impulseNoise === undefined ? [] : [entry.impulseNoise.handle],
      ),
    plan(data, context) {
      pendingFrames.delete(feature);
      const failed = data.sourceBlockers.find((blocker) => blocker.status !== 'pending');
      if (failed !== undefined)
        return err(
          new RenderFeatureStageFailedError(
            WATER_FLUID_FEATURE_IDENTITY,
            -1,
            'plan',
            'next-frame',
            {
              expected:
                'same-generation Water fluid Body, ready WaveSet and default impulse noise dependencies',
              ...failed,
            },
          ),
        );
      const pending = data.sourceBlockers[0];
      if (pending !== undefined)
        return ok({
          pendingSource: { resource: pending.guid, reason: 'asset-dependency-pending' },
          work: [],
        });
      if (waterInfoFeature !== undefined) {
        const readiness = fluidWaterInfoReadiness(waterInfoFeature, data, context);
        if (!readiness.ok) return readiness;
        if (readiness.value !== undefined) return ok({ pendingSource: readiness.value, work: [] });
      }
      const validateFluidDeviceLimits = () => {
        if (data.simulations.length > 0) {
          const dimension = context.limits?.maxTextureDimension2D ?? 8192;
          const layers = context.limits?.maxTextureArrayLayers ?? 256;
          const storage = context.limits?.maxStorageBufferBindingSize ?? 128 * 1024 * 1024;
          if (
            !context.caps.storageBuffer ||
            !context.caps.rgba32floatRenderable ||
            data.simulations.length * 5 > layers ||
            data.simulations.some(
              ({ frame }) =>
                frame.instance.recipe.resolution.some((size) => size > dimension) ||
                frame.instance.recipe.waveFoam.resolution > dimension ||
                Math.max(16, frame.impulses.length * 48) > storage ||
                Object.values(frame.instance.recipe.targets).some((target) =>
                  target.format === 'rgba32float' || target.format === 'rg32float'
                    ? !context.caps.rgba32floatRenderable
                    : !context.caps.rgba16floatRenderable,
                ),
            )
          )
            return err(
              new RenderFeatureStageFailedError(
                WATER_FLUID_FEATURE_IDENTITY,
                -1,
                'plan',
                'next-frame',
                {
                  expected:
                    'Water fluid storage buffers, renderable target formats, texture dimensions and array layers within device limits',
                  detail: { dimension, layers, storage, simulations: data.simulations.length },
                },
              ),
            );
        }
        return undefined;
      };
      const deviceFailure = validateFluidDeviceLimits();
      if (deviceFailure !== undefined) return deviceFailure;
      const live = new Set(data.simulations.map(waterFluidSimulationKey));
      for (const key of submitted.keys()) if (!live.has(key)) submitted.delete(key);
      const simulations: WaterFluidRenderFrame['simulations'][number][] = [];
      const prepareFluidSimulations = () => {
        for (const entry of data.simulations) {
          const { worldIndex, worldIdentity, frame, impulseNoise } = entry;
          const resolved =
            impulseNoise === undefined
              ? undefined
              : (context.resolveAsset?.(impulseNoise.handle, impulseNoise.revision) ??
                ok(impulseNoise.asset));
          if (
            impulseNoise === undefined ||
            resolved?.ok !== true ||
            resolved.value.kind !== 'texture' ||
            resolved.value.shape.viewDimension !== '2d'
          )
            return err(
              new RenderFeatureStageFailedError(
                WATER_FLUID_FEATURE_IDENTITY,
                -1,
                'plan',
                'next-frame',
                {
                  expected: 'the exact captured default impulse 2D noise TextureAsset',
                  worldIndex,
                  guid: frame.instance.recipe.impulseNoiseGuid,
                },
              ),
            );
          simulations.push({
            worldIndex,
            worldIdentity,
            impulseNoise: { ...impulseNoise, asset: resolved.value },
            frame: prepareWaterFluidFrame(
              frame.instance,
              frame.simulationGeneration,
              frame.timeSeconds,
              context.deviceGeneration ?? 0,
              frame.sourceFrame,
              frame.pendingImpulses,
              submitted.get(waterFluidSimulationKey(entry)),
              frame.initialActiveImpulses,
            ),
          });
        }
        return undefined;
      };
      const simulationFailure = prepareFluidSimulations();
      if (simulationFailure !== undefined) return simulationFailure;
      const render: WaterFluidRenderFrame = {
        token: `${context.frame.frameNumber}:${++serial}`,
        simulations,
        waterInfoViewIdentity: context.views.find((view) => view.render)?.identity,
        frameNumber: context.frame.frameNumber,
        deviceGeneration: context.deviceGeneration ?? 0,
        encoded: new Set(),
        required: new Set(),
      };
      const prepareContactFoam = () => {
        if (foamOptions !== undefined && data.contactFoam !== undefined) {
          const available = new Set(data.contactFoamBodies?.map(waterFluidFoamOwnerKey));
          const materialInputs = context.views
            .filter((view) => view.render)
            .flatMap((view) => view.frame.waterFoamMaterials ?? []);
          const materials = materialInputs.filter((material) =>
            available.has(waterFluidFoamOwnerKey(material)),
          );
          const clock = data.contactFoam.worldTimes.find(
            (row) => row.worldIdentity === materials[0]?.worldIdentity,
          );
          const prepared = prepareWaterFluidFoamFrame(
            {
              ...data.contactFoam,
              timeSeconds: materials.length === 0 ? 0 : (clock?.timeSeconds ?? NaN),
              materials,
            },
            foamOptions,
            render.deviceGeneration,
            data.sourceFrame,
            submittedFoam,
          );
          if (!prepared.ok)
            return err(
              new RenderFeatureStageFailedError(
                WATER_FLUID_FEATURE_IDENTITY,
                -1,
                'plan',
                'next-frame',
                {
                  expected:
                    'one exact admitted Ocean owner and FoamRT mapping, current contact identities and bounded fluid options',
                  ...prepared.error,
                },
              ),
            );
          if (prepared.value !== undefined) {
            const dimension = context.limits?.maxTextureDimension2D ?? 8192;
            const storage = context.limits?.maxStorageBufferBindingSize ?? 128 * 1024 * 1024;
            if (
              !context.caps.storageBuffer ||
              !context.caps.rgba16floatRenderable ||
              foamOptions.resolution > dimension ||
              WATER_FLUID_FOAM_EVENT_CAPACITY * WATER_FLUID_FOAM_EVENT_STRIDE_BYTES > storage
            )
              return err(
                new RenderFeatureStageFailedError(
                  WATER_FLUID_FEATURE_IDENTITY,
                  -1,
                  'plan',
                  'next-frame',
                  {
                    expected:
                      'contact FoamRT renderable format, storage buffer and dimensions within device limits',
                    detail: { dimension, storage, resolution: foamOptions.resolution },
                  },
                ),
              );
            Object.assign(render, { contactFoam: prepared.value });
            const owners = new Set(prepared.value.owners.map(waterFluidFoamOwnerKey));
            Object.assign(render, {
              shallowFoamSources:
                data.shallowFoamSources?.filter((source) =>
                  owners.has(waterFluidFoamOwnerKey(source)),
                ) ?? [],
            });
          }
        }
        return undefined;
      };
      const foamFailure = prepareContactFoam();
      if (foamFailure !== undefined) return foamFailure;
      const feedback: FluidFeedback = {
        kind: 'water-fluid-submitted',
        sourceFrame: data.sourceFrame,
        submitted: [],
      };
      candidates.set(data, { render, feedback });
      pendingFrames.set(feature, render);
      return ok({
        work: [{ scope: 'frame', resources: [], passes: [] }],
        sourceFeedback: feedback,
      });
    },
    onFrameSubmitted(data) {
      const candidate = candidates.get(data);
      if (candidate === undefined) return;
      const { render, feedback } = candidate;
      for (const entry of render.simulations) {
        const id = waterFluidSimulationKey(entry);
        const required = [...render.required].filter((pass) => pass.startsWith(`${id}/`));
        if (required.length > 0 && required.every((pass) => render.encoded.has(pass))) {
          feedback.submitted.push(entry);
          submitted.set(id, entry.frame);
        }
      }
      const foamWrites = [...render.required].filter((pass) => pass.startsWith('contact-foam/'));
      if (
        render.contactFoam !== undefined &&
        foamWrites.length > 0 &&
        [...render.required].every((pass) => render.encoded.has(pass))
      ) {
        submittedFoam = render.contactFoam;
        feedback.contactFoam = render.contactFoam;
      }
      if (render.contactFoam === undefined) submittedFoam = undefined;
      if (pendingFrames.get(feature) === render) pendingFrames.delete(feature);
      candidates.delete(data);
    },
    onSourceFrameSubmitted(data, feedback) {
      const value = feedback as FluidFeedback | undefined;
      if (
        value?.kind === 'water-fluid-submitted' &&
        value.sourceFrame === data.sourceFrame &&
        Array.isArray(value.submitted)
      ) {
        commit(data, value.submitted);
        if (value.contactFoam?.sourceFrame === data.sourceFrame) {
          for (const [root, step] of Object.entries(value.contactFoam.cursors))
            acknowledgedFoamCursors.set(
              root,
              Math.max(acknowledgedFoamCursors.get(root) ?? -1, step),
            );
          for (const [key, entry] of queuedFoamEvents) {
            const root = waterFluidFoamRootKey({
              ...entry.event,
              worldIdentity: entry.worldIdentity,
            });
            if (entry.event.sourcePhysicsStep <= (acknowledgedFoamCursors.get(root) ?? -1))
              queuedFoamEvents.delete(key);
          }
        }
      }
    },
    onFrameAborted(data) {
      if (pendingFrames.get(feature) === candidates.get(data)?.render)
        pendingFrames.delete(feature);
      candidates.delete(data);
    },
  };
  return feature;
}
