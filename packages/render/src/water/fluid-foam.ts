import { err, ok, type Result } from '@forgeax/engine-types';
import type { WaterSplashWakeEvent, WaterVisualContact } from '@forgeax/engine-water';
import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { sceneSurfaceRowsOf } from '../scene/render-scene-view';

export const WATER_FLUID_FOAM_EVENT_CAPACITY = 4096;
export const WATER_FLUID_FOAM_EVENT_STRIDE_BYTES = 32;

export interface WaterFluidFoamOptions {
  readonly resolution: number;
  readonly decayPerSecond: number;
  /** Instantaneous contact coverage per m/s; max history does not integrate step duration. */
  readonly strengthPerMps: number;
  readonly maximumEventAgeSeconds?: number;
}
export interface WaterFluidFoamOwner {
  readonly worldIdentity: string;
  readonly bodyGuid: string;
  readonly bodyGeneration: number;
}
export interface WaterFluidFoamMaterial extends WaterFluidFoamOwner {
  readonly materialHandle: number;
  readonly mapping:
    | {
        readonly kind: 'mapped';
        readonly centerXZ: readonly [number, number];
        readonly extentM: number;
      }
    | { readonly kind: 'invalid'; readonly field: 'simulationLocationM' | 'waveCaptureSizeM' };
}
export interface WaterFluidFoamRoot {
  readonly worldIdentity: string;
  readonly rootEntity: number;
  readonly rootGeneration: number;
  readonly sourceIdentity?: string;
}
export interface WaterFluidFoamEvent {
  readonly worldIdentity: string;
  readonly event: WaterSplashWakeEvent | WaterVisualContact;
}
export interface WaterFluidFoamInput {
  readonly receiverSession?: string;
  readonly timeSeconds: number;
  readonly materials: readonly WaterFluidFoamMaterial[];
  readonly roots: readonly WaterFluidFoamRoot[];
  readonly events: readonly WaterFluidFoamEvent[];
}
export interface WaterFluidFoamFrame {
  readonly receiverSession: string | undefined;
  readonly sourceFrame: number;
  readonly deviceGeneration: number;
  readonly generation: number;
  readonly identity: string;
  readonly initialize: boolean;
  readonly timeSeconds: number;
  readonly deltaSeconds: number;
  readonly options: WaterFluidFoamOptions;
  readonly mapping: Extract<WaterFluidFoamMaterial['mapping'], { kind: 'mapped' }>;
  readonly owners: readonly WaterFluidFoamOwner[];
  readonly roots: readonly WaterFluidFoamRoot[];
  readonly events: readonly WaterFluidFoamEvent[];
  readonly cursors: Readonly<Record<string, number>>;
  readonly readSide: 0 | 1;
}
export interface WaterFluidFoamError {
  readonly reason:
    | 'configuration-invalid'
    | 'mapping-invalid'
    | 'mapping-conflict'
    | 'owner-conflict'
    | 'stale-source-frame'
    | 'event-budget-exceeded';
  readonly detail: unknown;
}
export const waterFluidFoamOwnerKey = (owner: WaterFluidFoamOwner): string =>
  JSON.stringify([owner.worldIdentity, owner.bodyGuid, owner.bodyGeneration]);
export const waterFluidFoamRootKey = (root: WaterFluidFoamRoot): string =>
  JSON.stringify([
    root.worldIdentity,
    root.rootEntity,
    root.rootGeneration,
    root.sourceIdentity ?? 'buoyancy',
  ]);
export const waterFluidFoamEventKey = (entry: WaterFluidFoamEvent): string =>
  JSON.stringify([
    entry.worldIdentity,
    entry.event.rootEntity,
    entry.event.rootGeneration,
    entry.event.sourcePhysicsStep,
    'probeId' in entry.event ? entry.event.probeId : entry.event.pontoonId,
    'sourceIdentity' in entry.event ? entry.event.sourceIdentity : 'buoyancy',
  ]);

export function waterFluidFoamContactStrength(
  velocityMps: readonly [number, number, number],
  strengthPerMps: number,
): number {
  return Math.min(1, Math.hypot(...velocityMps) * strengthPerMps);
}

export function waterFluidFoamEventCurrent(
  queryTimeSeconds: number,
  timeSeconds: number,
  maximumEventAgeSeconds = 8,
): boolean {
  return (
    Number.isFinite(queryTimeSeconds) &&
    Number.isFinite(timeSeconds) &&
    timeSeconds - queryTimeSeconds < maximumEventAgeSeconds
  );
}

const NO_FOAM_MATERIALS: readonly WaterFluidFoamMaterial[] = Object.freeze([]);

/** Derive the shader's exact mapping from the admitted material value snapshot. */
export function captureWaterFluidFoamMaterials(
  renderables: FrameList<RenderableSnapshot>,
  viewIdentity: string,
  dispatch?: Iterable<Pick<DispatchEntry, 'renderableIndex' | 'materialHandle'>>,
): readonly WaterFluidFoamMaterial[] {
  if (sceneSurfaceRowsOf(renderables, renderables.at)?.source.mayHaveWaterSources === false)
    return NO_FOAM_MATERIALS;
  const result = new Map<string, WaterFluidFoamMaterial>();
  const draws = dispatch === undefined ? undefined : [...dispatch];
  for (const [index, row] of [...renderables].entries()) {
    if (row.authorVisible === false) continue;
    const source = row.waterMeshSource;
    const owner = row.waterOwner ?? source;
    if (owner === undefined) continue;
    const materials =
      source === undefined
        ? row.materials.filter(
            (resource) =>
              draws === undefined ||
              draws.some(
                (draw) =>
                  draw.renderableIndex === index &&
                  draw.materialHandle === resource.snapshot.materialHandle,
              ),
          )
        : (source.views
            .find((view) => view.viewIdentity === viewIdentity)
            ?.draws.map((draw) => row.materials[draw.materialIndex]) ?? []);
    for (const resource of materials) {
      const material = resource?.snapshot;
      if (
        material?.staticSwitches?.waterOceanFoam !== true ||
        material.staticSwitches.waterFoam === false
      )
        continue;
      const location = material.paramSnapshot?.simulationLocationM;
      const extent = material.paramSnapshot?.waveCaptureSizeM;
      const mapping: WaterFluidFoamMaterial['mapping'] =
        !Array.isArray(location) || location.length !== 3 || !location.every(Number.isFinite)
          ? { kind: 'invalid', field: 'simulationLocationM' }
          : typeof extent !== 'number' || !Number.isFinite(extent) || extent <= 0
            ? { kind: 'invalid', field: 'waveCaptureSizeM' }
            : {
                kind: 'mapped',
                centerXZ: Object.freeze([Number(location[0]), Number(location[2])] as const),
                extentM: extent,
              };
      const entry: WaterFluidFoamMaterial = Object.freeze({
        worldIdentity: owner.worldIdentity,
        bodyGuid: owner.guid,
        bodyGeneration: owner.generation,
        materialHandle: material.materialHandle ?? 0,
        mapping: Object.freeze(mapping),
      });
      result.set(
        JSON.stringify([waterFluidFoamOwnerKey(entry), entry.materialHandle, mapping]),
        entry,
      );
    }
  }
  return Object.freeze([...result.values()]);
}

/** Candidate history is committed only by the existing fluid feature's submit hook. */
export function prepareWaterFluidFoamFrame(
  input: WaterFluidFoamInput,
  options: WaterFluidFoamOptions,
  deviceGeneration: number,
  sourceFrame: number,
  submitted?: WaterFluidFoamFrame,
): Result<WaterFluidFoamFrame | undefined, WaterFluidFoamError> {
  if (
    !Number.isInteger(options.resolution) ||
    options.resolution < 16 ||
    !Number.isFinite(options.decayPerSecond) ||
    options.decayPerSecond < 0 ||
    !Number.isFinite(options.strengthPerMps) ||
    options.strengthPerMps < 0 ||
    (options.maximumEventAgeSeconds !== undefined &&
      (!Number.isFinite(options.maximumEventAgeSeconds) || options.maximumEventAgeSeconds <= 0)) ||
    !Number.isFinite(input.timeSeconds)
  )
    return err({ reason: 'configuration-invalid', detail: options });
  if (
    submitted?.deviceGeneration === deviceGeneration &&
    submitted.receiverSession === input.receiverSession &&
    sourceFrame <= submitted.sourceFrame
  )
    return err({
      reason: 'stale-source-frame',
      detail: { sourceFrame, submitted: submitted.sourceFrame },
    });
  const invalid = input.materials.find((material) => material.mapping.kind === 'invalid');
  if (invalid !== undefined) return err({ reason: 'mapping-invalid', detail: invalid });
  const material = input.materials[0];
  if (material?.mapping.kind !== 'mapped') return ok(undefined);
  const mapping = material.mapping;
  const ownerKey = waterFluidFoamOwnerKey(material);
  if (input.materials.some((entry) => waterFluidFoamOwnerKey(entry) !== ownerKey))
    return err({ reason: 'owner-conflict', detail: input.materials });
  const mappingKey = JSON.stringify([mapping.centerXZ, mapping.extentM]);
  if (
    input.materials.some(
      (entry) =>
        entry.mapping.kind !== 'mapped' ||
        JSON.stringify([entry.mapping.centerXZ, entry.mapping.extentM]) !== mappingKey,
    )
  )
    return err({ reason: 'mapping-conflict', detail: input.materials });
  const owners = [
    ...new Map(
      input.materials.map((entry) => [
        waterFluidFoamOwnerKey(entry),
        Object.freeze({
          worldIdentity: entry.worldIdentity,
          bodyGuid: entry.bodyGuid,
          bodyGeneration: entry.bodyGeneration,
        }),
      ]),
    ).entries(),
  ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const roots = [
    ...new Map(input.roots.map((root) => [waterFluidFoamRootKey(root), root])).entries(),
  ]
    .filter(([, root]) => owners.some(([, owner]) => owner.worldIdentity === root.worldIdentity))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const identity = JSON.stringify([
    deviceGeneration,
    input.receiverSession,
    mappingKey,
    owners.map(([key]) => key),
    options,
  ]);
  const initialize = submitted?.identity !== identity;
  const liveRoots = new Set(roots.map(([key]) => key));
  const liveOwners = new Set(owners.map(([key]) => key));
  const cursors: Record<string, number> = initialize
    ? {}
    : Object.fromEntries(Object.entries(submitted.cursors).filter(([root]) => liveRoots.has(root)));
  const visualRoots = new Set(
    roots
      .filter(([, root]) => root.sourceIdentity !== undefined)
      .map(([, root]) =>
        JSON.stringify([root.worldIdentity, root.rootEntity, root.rootGeneration]),
      ),
  );
  const events = new Map<string, WaterFluidFoamEvent>();
  const collectCurrentFoamEvents = () => {
    for (const entry of input.events) {
      const event = entry.event;
      const root = waterFluidFoamRootKey({ ...event, worldIdentity: entry.worldIdentity });
      const owner =
        event.bodyGuid === undefined || event.bodyGeneration === undefined
          ? undefined
          : waterFluidFoamOwnerKey({
              worldIdentity: entry.worldIdentity,
              bodyGuid: event.bodyGuid,
              bodyGeneration: event.bodyGeneration,
            });
      if (!liveRoots.has(root) || owner === undefined || !liveOwners.has(owner)) continue;
      if (event.sourcePhysicsStep <= (initialize ? -1 : (submitted.cursors[root] ?? -1))) continue;
      cursors[root] = Math.max(cursors[root] ?? -1, event.sourcePhysicsStep);
      if (
        !waterFluidFoamEventCurrent(
          event.queryTimeSeconds,
          input.timeSeconds,
          options.maximumEventAgeSeconds,
        )
      )
        continue;
      // Authored hull probes own visible contact geometry; force pontoons remain DI inputs.
      if (
        !('kind' in event && event.kind === 'visual-probe') &&
        visualRoots.has(
          JSON.stringify([entry.worldIdentity, event.rootEntity, event.rootGeneration]),
        )
      )
        continue;
      if (event.phase !== 'exited' && event.contact.kind === 'water-plane-intersection')
        events.set(waterFluidFoamEventKey(entry), entry);
    }
  };
  collectCurrentFoamEvents();
  if (events.size > WATER_FLUID_FOAM_EVENT_CAPACITY)
    return err({
      reason: 'event-budget-exceeded',
      detail: { count: events.size, maximum: WATER_FLUID_FOAM_EVENT_CAPACITY },
    });
  const publishFoamFrame = () => {
    return ok(
      Object.freeze({
        receiverSession: input.receiverSession,
        sourceFrame,
        deviceGeneration,
        generation: initialize ? (submitted?.generation ?? 0) + 1 : submitted.generation,
        identity,
        initialize,
        timeSeconds: input.timeSeconds,
        deltaSeconds: initialize ? 0 : Math.max(0, input.timeSeconds - submitted.timeSeconds),
        options: Object.freeze({ ...options }),
        mapping,
        owners: Object.freeze(owners.map(([, owner]) => owner)),
        roots: Object.freeze(roots.map(([, root]) => root)),
        events: Object.freeze([...events.values()]),
        cursors: Object.freeze(cursors),
        readSide: initialize ? 0 : submitted.readSide === 0 ? 1 : 0,
      }),
    );
  };
  return publishFoamFrame();
}
