import type { Vec2, WaterZoneAsset } from './contracts.js';
export type WaterInfoFormat = 'rgba16f' | 'rgba32f';
export type WaterInfoViewMode = 'shared-zone' | 'view-local';
export interface WaterInfoSliceReservation {
  readonly zoneGuid: string;
  readonly viewId: string;
  readonly resourceGroup?: string;
  readonly slice: number;
  readonly deviceGeneration: number;
  readonly reservationGeneration: number;
}
export interface WaterInfoContext {
  readonly zoneGuid: string;
  readonly viewId: string;
  readonly slice: number;
  readonly centerXZ: Vec2;
  readonly extentXZ: Vec2;
  readonly waterYMinM: number;
  readonly waterYMaxM: number;
  readonly groundYMinM: number;
  readonly maxVelocityMPerSec: number;
  readonly format: WaterInfoFormat;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly blurRadius: number;
  readonly zoneGeneration: number;
  readonly deviceGeneration: number;
  readonly frameGeneration: number;
  readonly graphResourceVersion: string;
  readonly sourceDigest: string;
}
export interface WaterInfoContextInput {
  readonly zoneGuid: string;
  readonly viewId: string;
  readonly zone: WaterZoneAsset;
  readonly centerXZ: Vec2;
  readonly extentXZ?: Vec2;
  readonly waterYMinM: number;
  readonly waterYMaxM: number;
  readonly groundYMinM: number;
  readonly maxVelocityMPerSec: number;
  readonly zoneGeneration: number;
  readonly deviceGeneration: number;
  readonly frameGeneration: number;
  readonly sourceDigest: string;
}
export function waterInfoSliceReservationKey(
  reservation: Pick<
    WaterInfoSliceReservation,
    'zoneGuid' | 'viewId' | 'deviceGeneration' | 'resourceGroup'
  >,
): string {
  return JSON.stringify([
    reservation.zoneGuid,
    reservation.viewId,
    reservation.deviceGeneration,
    reservation.resourceGroup ?? '',
  ]);
}
interface WaterInfoReservationState extends WaterInfoSliceReservation {
  readonly resourceGroup: string;
  readonly contextGeneration: number;
  completedFrameGeneration?: number;
  completedGraphResourceVersion?: string;
}
/**
 * Assigns stable array layers to a Zone/view/device epoch. A reservation only
 * becomes reusable after its graph submission receipt is committed.
 */
export class WaterInfoSliceAllocator {
  readonly #slots = new Map<string, WaterInfoReservationState>();
  #nextReservationGeneration = 0;
  #contextGeneration = 0;
  constructor(readonly maxSlices: number) {
    if (!Number.isInteger(maxSlices) || maxSlices < 1)
      throw new RangeError('WaterInfo requires at least one array layer');
  }
  reserve(input: {
    readonly zoneGuid: string;
    readonly viewId: string;
    readonly mode: WaterInfoViewMode;
    readonly deviceGeneration: number;
    readonly resourceGroup?: string;
  }): WaterInfoSliceReservation | undefined {
    if (
      !input.zoneGuid ||
      !input.viewId ||
      !Number.isSafeInteger(input.deviceGeneration) ||
      input.deviceGeneration < 0
    )
      return undefined;
    const viewId = input.mode === 'shared-zone' ? 'shared' : input.viewId;
    const resourceGroup = input.resourceGroup ?? '';
    const key = waterInfoSliceReservationKey({
      zoneGuid: input.zoneGuid,
      viewId,
      deviceGeneration: input.deviceGeneration,
      resourceGroup,
    });
    const existing = this.#slots.get(key);
    if (existing)
      return Object.freeze({
        zoneGuid: existing.zoneGuid,
        viewId: existing.viewId,
        resourceGroup: existing.resourceGroup,
        slice: existing.slice,
        deviceGeneration: existing.deviceGeneration,
        reservationGeneration: existing.reservationGeneration,
      });
    const occupied = new Set(
      [...this.#slots.values()]
        .filter(
          (slot) =>
            slot.deviceGeneration === input.deviceGeneration &&
            slot.resourceGroup === resourceGroup,
        )
        .map((slot) => slot.slice),
    );
    let slice = 0;
    while (occupied.has(slice) && slice < this.maxSlices) slice++;
    if (slice >= this.maxSlices) return undefined;
    const reservation = Object.freeze({
      zoneGuid: input.zoneGuid,
      viewId,
      resourceGroup,
      slice,
      deviceGeneration: input.deviceGeneration,
      reservationGeneration: ++this.#nextReservationGeneration,
      contextGeneration: ++this.#contextGeneration,
    });
    this.#slots.set(key, reservation);
    return Object.freeze({
      zoneGuid: reservation.zoneGuid,
      viewId: reservation.viewId,
      resourceGroup: reservation.resourceGroup,
      slice: reservation.slice,
      deviceGeneration: reservation.deviceGeneration,
      reservationGeneration: reservation.reservationGeneration,
    });
  }
  commit(
    reservation: WaterInfoSliceReservation,
    receipt: {
      readonly frameGeneration: number;
      readonly graphResourceVersion: string;
    },
  ): boolean {
    const key = waterInfoSliceReservationKey(reservation);
    const current = this.#slots.get(key);
    if (
      !current ||
      current.reservationGeneration !== reservation.reservationGeneration ||
      !Number.isSafeInteger(receipt.frameGeneration) ||
      receipt.frameGeneration < 0 ||
      !receipt.graphResourceVersion
    )
      return false;
    this.#slots.set(key, {
      ...current,
      completedFrameGeneration: receipt.frameGeneration,
      completedGraphResourceVersion: receipt.graphResourceVersion,
    });
    return true;
  }
  /** Matches only an exact submitted context receipt; cross-frame target-content reuse is tracked by WaterInfo publication state. */
  isReusable(
    reservation: WaterInfoSliceReservation,
    expected: {
      readonly zoneGeneration: number;
      readonly deviceGeneration: number;
      readonly sourceDigest: string;
    },
    context: WaterInfoContext,
  ): boolean {
    const key = waterInfoSliceReservationKey(reservation);
    const current = this.#slots.get(key);
    return (
      !!current &&
      current.reservationGeneration === reservation.reservationGeneration &&
      current.completedFrameGeneration === context.frameGeneration &&
      current.completedGraphResourceVersion === context.graphResourceVersion &&
      context.zoneGeneration === expected.zoneGeneration &&
      context.deviceGeneration === expected.deviceGeneration &&
      context.sourceDigest === expected.sourceDigest
    );
  }
  releaseView(zoneGuid: string, viewId: string): void {
    for (const [key, slot] of this.#slots)
      if (slot.zoneGuid === zoneGuid && slot.viewId === viewId) this.#slots.delete(key);
  }
  releaseExcept(reservations: ReadonlySet<string>): void {
    for (const [key, slot] of this.#slots) {
      const identity = waterInfoSliceReservationKey(slot);
      if (!reservations.has(identity)) this.#slots.delete(key);
    }
  }
  invalidateDevice(deviceGeneration: number): void {
    for (const [key, slot] of this.#slots)
      if (slot.deviceGeneration !== deviceGeneration) this.#slots.delete(key);
  }
  snapshot(): readonly WaterInfoSliceReservation[] {
    return Object.freeze(
      [...this.#slots.values()].map(
        ({ zoneGuid, viewId, resourceGroup, slice, deviceGeneration, reservationGeneration }) =>
          Object.freeze({
            zoneGuid,
            viewId,
            resourceGroup,
            slice,
            deviceGeneration,
            reservationGeneration,
          }),
      ),
    );
  }
}
function validWaterInfoPublicationNumbers(input: WaterInfoContextInput): boolean {
  return !(
    ![input.waterYMinM, input.waterYMaxM, input.groundYMinM, input.maxVelocityMPerSec].every(
      Number.isFinite,
    ) ||
    input.waterYMaxM < input.waterYMinM ||
    input.maxVelocityMPerSec <= 0 ||
    !Number.isSafeInteger(input.zoneGeneration) ||
    input.zoneGeneration < 0 ||
    !Number.isSafeInteger(input.deviceGeneration) ||
    input.deviceGeneration < 0 ||
    !Number.isSafeInteger(input.frameGeneration) ||
    input.frameGeneration < 0 ||
    !input.sourceDigest
  );
}

export function createWaterInfoContext(
  input: WaterInfoContextInput,
  reservation: WaterInfoSliceReservation,
): WaterInfoContext | undefined {
  const { zone } = input;
  const extent: Vec2 = input.extentXZ ?? [zone.extentM.spanXM, zone.extentM.spanZM];
  const formatGroup = zone.waterInfo.format === 'rgba32f' ? 'rgba32float' : 'rgba16float';
  if (
    reservation.zoneGuid !== input.zoneGuid ||
    reservation.viewId !== (zone.waterInfo.localTessellation ? input.viewId : 'shared') ||
    reservation.deviceGeneration !== input.deviceGeneration ||
    input.centerXZ.length !== 2 ||
    (reservation.resourceGroup !== undefined && reservation.resourceGroup !== formatGroup) ||
    !input.centerXZ.every(Number.isFinite) ||
    extent.length !== 2 ||
    extent.some((value) => !Number.isFinite(value) || value <= 0) ||
    !validWaterInfoPublicationNumbers(input)
  )
    return undefined;
  return Object.freeze({
    zoneGuid: input.zoneGuid,
    viewId: zone.waterInfo.localTessellation ? input.viewId : 'shared',
    slice: reservation.slice,
    centerXZ: Object.freeze<Vec2>([...input.centerXZ]),
    extentXZ: Object.freeze<Vec2>(extent),
    waterYMinM: input.waterYMinM,
    waterYMaxM: input.waterYMaxM,
    groundYMinM: input.groundYMinM,
    maxVelocityMPerSec: input.maxVelocityMPerSec,
    format: zone.waterInfo.format,
    widthPx: zone.waterInfo.resolution.widthPx,
    heightPx: zone.waterInfo.resolution.heightPx,
    blurRadius: Math.min(16, Math.max(0, Math.round(zone.waterInfo.blurRadius))),
    zoneGeneration: input.zoneGeneration,
    deviceGeneration: input.deviceGeneration,
    frameGeneration: input.frameGeneration,
    graphResourceVersion: `${input.zoneGuid}:${input.zoneGeneration}:${input.viewId}:${input.deviceGeneration}:${input.frameGeneration}`,
    sourceDigest: input.sourceDigest,
  });
}
/** Serialize one shader-visible WaterInfo descriptor in the group-4 ABI order. */
export function waterInfoDescriptorBytes(context: WaterInfoContext): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, context.slice, true);
  view.setUint32(4, context.widthPx, true);
  view.setUint32(8, context.heightPx, true);
  view.setUint32(12, 0, true);
  view.setFloat32(16, context.waterYMinM, true);
  view.setFloat32(20, context.waterYMaxM, true);
  view.setFloat32(24, context.groundYMinM, true);
  view.setFloat32(28, 0, true);
  view.setFloat32(32, context.centerXZ[0], true);
  view.setFloat32(36, context.centerXZ[1], true);
  view.setFloat32(40, context.extentXZ[0], true);
  view.setFloat32(44, context.extentXZ[1], true);
  return bytes;
}
export function waterInfoWorldToUv(
  context: Pick<WaterInfoContext, 'centerXZ' | 'extentXZ'>,
  worldXZ: Vec2,
): Vec2 {
  const minX = context.centerXZ[0] - context.extentXZ[0] * 0.5;
  const minZ = context.centerXZ[1] - context.extentXZ[1] * 0.5;
  return Object.freeze<Vec2>([
    Math.max(0, Math.min(1, (worldXZ[0] - minX) / context.extentXZ[0])),
    Math.max(0, Math.min(1, (worldXZ[1] - minZ) / context.extentXZ[1])),
  ]);
}
export function decodeWaterInfoVelocity(
  sample: readonly [number, number, number, number],
  maxVelocityMPerSec: number,
): Vec2 {
  return Object.freeze<Vec2>([
    (sample[0] - 0.5) * 2 * maxVelocityMPerSec,
    (sample[1] - 0.5) * 2 * maxVelocityMPerSec,
  ]);
}
export function decodeWaterInfoGroundHeight(
  sample: readonly [number, number, number, number],
  context: Pick<WaterInfoContext, 'groundYMinM' | 'waterYMaxM'>,
): number {
  return sample[3] * (context.waterYMaxM - context.groundYMinM) + context.groundYMinM;
}
export function decodeWaterInfoHeight(
  sample: readonly [number, number, number, number],
  context: Pick<WaterInfoContext, 'waterYMinM' | 'waterYMaxM' | 'groundYMinM'>,
): number {
  const ground = decodeWaterInfoGroundHeight(sample, context);
  return sample[2] <= 0
    ? ground - 2.56
    : sample[2] * (context.waterYMaxM - context.waterYMinM) + context.waterYMinM;
}
