import { waterBodyOwnerKey } from '@forgeax/engine-water';
import type { RenderableSnapshot } from '../render-system-extract';
import type { WaterMeshInstanceDrawUpload } from './wave-material';

type WaterMaterialSource = Pick<RenderableSnapshot, 'waterOwner' | 'waterMeshTiles'>;
type WaterMeshSource = NonNullable<RenderableSnapshot['waterMeshSource']>;
type WaterMeshTiles = NonNullable<RenderableSnapshot['waterMeshTiles']>;
type WaterMeshDraw = WaterMeshSource['views'][number]['draws'][number];
const OWNED_DRAW_UPLOAD = Symbol('owned-water-mesh-draw-upload');
const OWNED_UPLOAD = Symbol('owned-water-mesh-upload');
const OWNED_UPLOAD_CLOSURE = Symbol('owned-water-mesh-upload-closure');
const OWNED_WATER_MATERIAL_OWNER = Symbol('owned-water-material-owner');
type WithUpload = { readonly [OWNED_DRAW_UPLOAD]?: WaterMeshInstanceDrawUpload };
type WithWaterMaterialOwner = {
  readonly [OWNED_WATER_MATERIAL_OWNER]?: true;
};

export type WaterMaterialAdmissionDraw = Readonly<{
  readonly renderableIndex: number;
  readonly owner: NonNullable<RenderableSnapshot['waterOwner']>;
  readonly tiles?: NonNullable<RenderableSnapshot['waterMeshTiles']>;
}>;

export interface WaterMaterialAdmissionDrawClosure {
  readonly draws: readonly WaterMaterialAdmissionDraw[];
  readonly uploads: readonly WaterMeshInstanceDrawUpload[];
}

/** Seal Water association slots only while constructing a renderer-owned source snapshot. */
export function ownWaterMaterialAdmissionSource<T extends WaterMaterialSource>(source: T): T {
  try {
    lockOwnDataProperty(source, 'waterOwner', true);
    lockOwnDataProperty(source, 'waterMeshTiles', true);
  } catch {
    // Borrowed/custom sources keep their live property behavior.
  }
  return source;
}

/** Mark a Water owner captured by the renderer's source producer. */
export function ownWaterMaterialOwner(
  owner: NonNullable<RenderableSnapshot['waterOwner']>,
): NonNullable<RenderableSnapshot['waterOwner']> {
  Object.defineProperty(owner, OWNED_WATER_MATERIAL_OWNER, { value: true });
  return Object.freeze(owner);
}

export function isOwnedWaterMaterialOwner(
  owner: NonNullable<RenderableSnapshot['waterOwner']>,
): boolean {
  return (owner as WithWaterMaterialOwner)[OWNED_WATER_MATERIAL_OWNER] === true;
}

/**
 * Capture this finalized roster's complete owned Water closure without changing
 * its draw-owner rows or addresses. Source associations must already be immutable
 * from their producer; writable/custom sources stay on the live admission path.
 */
export function finalizeWaterMaterialAdmissionDraws(
  rows: readonly { readonly renderableIndex: number; readonly source: WaterMaterialSource }[],
): WaterMaterialAdmissionDrawClosure | undefined {
  const draws: WaterMaterialAdmissionDraw[] = [];
  const uploads: WaterMeshInstanceDrawUpload[] = [];
  try {
    for (const row of rows) {
      const readSealedWaterMaterialRow = () => {
        const sourceDescriptor = Object.getOwnPropertyDescriptor(row, 'source');
        const indexDescriptor = Object.getOwnPropertyDescriptor(row, 'renderableIndex');
        if (
          sourceDescriptor === undefined ||
          !('value' in sourceDescriptor) ||
          indexDescriptor === undefined ||
          !('value' in indexDescriptor) ||
          !Number.isSafeInteger(indexDescriptor.value)
        )
          return undefined;
        const source = sourceDescriptor.value as WaterMaterialSource;
        const ownerDescriptor = immutableOwnDataProperty(source, 'waterOwner', true);
        const tilesDescriptor = immutableOwnDataProperty(source, 'waterMeshTiles', true);
        if (
          ownerDescriptor === undefined ||
          tilesDescriptor === undefined ||
          !('value' in ownerDescriptor) ||
          !('value' in tilesDescriptor) ||
          ownerDescriptor.writable !== false ||
          ownerDescriptor.configurable !== false ||
          tilesDescriptor.writable !== false ||
          tilesDescriptor.configurable !== false
        )
          return undefined;

        return { sourceDescriptor, indexDescriptor, source, ownerDescriptor, tilesDescriptor };
      };
      const readSealedWaterMaterialRowResult = readSealedWaterMaterialRow();
      if (readSealedWaterMaterialRowResult === undefined) return undefined;
      const { indexDescriptor, ownerDescriptor, tilesDescriptor } =
        readSealedWaterMaterialRowResult;
      const owner = ownerDescriptor?.value as RenderableSnapshot['waterOwner'];
      if (owner === undefined) continue;
      if (!isOwnedWaterMaterialOwner(owner) || !Object.isFrozen(owner)) return undefined;
      const tiles = tilesDescriptor?.value as RenderableSnapshot['waterMeshTiles'];
      if (tiles !== undefined) {
        const tilesDescriptor = Object.getOwnPropertyDescriptor(tiles, OWNED_DRAW_UPLOAD);
        const upload =
          tilesDescriptor !== undefined && 'value' in tilesDescriptor
            ? (tilesDescriptor.value as WaterMeshInstanceDrawUpload)
            : undefined;
        if (
          upload === undefined ||
          !Object.isFrozen(tiles) ||
          !isOwnedWaterMeshAdmissionUpload(upload)
        )
          return undefined;
        uploads.push(upload);
      }
      draws.push(
        Object.freeze({
          renderableIndex: indexDescriptor.value as number,
          owner,
          ...(tiles === undefined ? {} : { tiles }),
        }),
      );
    }
  } catch {
    return undefined;
  }
  Object.defineProperty(uploads, OWNED_UPLOAD_CLOSURE, { value: true });
  return Object.freeze({ draws: Object.freeze(draws), uploads: Object.freeze(uploads) });
}

function lockOwnDataProperty<T extends object, K extends PropertyKey>(
  target: T,
  key: K,
  sealAbsent = false,
): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) {
    if (!sealAbsent || key in target) return undefined;
    if (!Object.isExtensible(target))
      return { value: undefined, enumerable: false, writable: false, configurable: false };
    Object.defineProperty(target, key, {
      value: undefined,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return Object.getOwnPropertyDescriptor(target, key);
  }
  if (!('value' in descriptor)) return undefined;
  if (descriptor.writable !== false || descriptor.configurable !== false) {
    Object.defineProperty(target, key, {
      ...descriptor,
      writable: false,
      configurable: false,
    });
  }
  return Object.getOwnPropertyDescriptor(target, key);
}

function immutableOwnDataProperty<T extends object, K extends PropertyKey>(
  target: T,
  key: K,
  allowAbsent = false,
): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) {
    if (!allowAbsent || key in target || Object.isExtensible(target)) return undefined;
    return { value: undefined, enumerable: false, writable: false, configurable: false };
  }
  return 'value' in descriptor && descriptor.writable === false && descriptor.configurable === false
    ? descriptor
    : undefined;
}

function retainUpload<T extends object>(value: T, upload: WaterMeshInstanceDrawUpload): T {
  Object.defineProperty(value, OWNED_DRAW_UPLOAD, { value: upload });
  return value;
}

function normalizeUpload(tiles: WaterMeshTiles): WaterMeshInstanceDrawUpload {
  return Object.freeze({
    drawKey: tiles.drawKey,
    bodyGuid: waterBodyOwnerKey(
      tiles.worldIdentity,
      tiles.bodyGuid,
      tiles.bodyGeneration,
      tiles.zoneGeneration,
    ),
    bodyGeneration: tiles.bodyGeneration,
    zoneGeneration: tiles.zoneGeneration,
    viewIdentity: tiles.viewIdentity,
    bytes: tiles.bytes,
    coverageBytes: tiles.coverageBytes,
    layout: tiles.layout,
    transitionTargets: Object.freeze(
      tiles.transitionTargets.map((target) =>
        Object.freeze({
          instanceIndex: target.instanceIndex,
          bodyGuid: waterBodyOwnerKey(
            tiles.worldIdentity,
            target.bodyGuid,
            target.bodyGeneration,
            tiles.zoneGeneration,
          ),
          bodyGeneration: target.bodyGeneration,
          zoneGeneration: tiles.zoneGeneration,
        }),
      ),
    ),
  });
}

/** Receiver admission detaches every mutable input before retaining its fixed upload. */
export function ownWaterMeshAdmissionDraw<
  T extends Pick<
    WaterMeshDraw,
    'drawKey' | 'bytes' | 'coverageBytes' | 'layout' | 'transitionTargets'
  >,
>(
  source: Pick<WaterMeshSource, 'guid' | 'generation' | 'worldIdentity' | 'zoneGeneration'>,
  viewIdentity: string,
  draw: T,
): T {
  const owned = {
    ...draw,
    bytes: draw.bytes.slice(),
    coverageBytes: draw.coverageBytes.slice(),
    layout: Object.freeze({ ...draw.layout, offsets: Object.freeze({ ...draw.layout.offsets }) }),
    transitionTargets: Object.freeze(
      draw.transitionTargets.map((target) => Object.freeze({ ...target })),
    ),
  };
  const normalized = normalizeUpload({
    ...owned,
    bodyGuid: source.guid,
    bodyGeneration: source.generation,
    worldIdentity: source.worldIdentity,
    zoneGeneration: source.zoneGeneration,
    viewIdentity,
  });
  const upload = { ...normalized };
  Object.defineProperty(upload, OWNED_UPLOAD, { value: upload });
  return Object.freeze(retainUpload(owned, Object.freeze(upload)));
}

/**
 * Retain the renderer-only WaterSystem candidate's fixed upload without copying it.
 * The candidate API is private to the renderer; public WaterSystem candidate APIs detach bytes.
 */
export function retainWaterMeshCandidateAdmissionDraw(
  source: Pick<WaterMeshSource, 'guid' | 'generation' | 'worldIdentity' | 'zoneGeneration'>,
  viewIdentity: string,
  draw: WaterMeshDraw,
): WaterMeshDraw {
  const normalized = normalizeUpload({
    ...draw,
    bodyGuid: source.guid,
    bodyGeneration: source.generation,
    worldIdentity: source.worldIdentity,
    zoneGeneration: source.zoneGeneration,
    viewIdentity,
  });
  const upload = { ...normalized };
  Object.defineProperty(upload, OWNED_UPLOAD, { value: upload });
  return Object.freeze(retainUpload({ ...draw }, Object.freeze(upload)));
}

/** Material addressing changes no Water tile, owner, transition or upload facts. */
export function offsetWaterMeshAdmissionDraw(draw: WaterMeshDraw, offset: number): WaterMeshDraw {
  const next = { ...draw, materialIndex: draw.materialIndex + offset };
  const upload = (draw as WithUpload)[OWNED_DRAW_UPLOAD];
  return Object.freeze(upload === undefined ? next : retainUpload(next, upload));
}

/** A current projection may inherit only the exact admitted byte and owner closure. */
export function projectWaterMeshAdmissionTiles(
  tiles: WaterMeshTiles,
  draw: Pick<WaterMeshDraw, 'transitionTargets'>,
): WaterMeshTiles {
  const upload = (draw as WithUpload)[OWNED_DRAW_UPLOAD];
  return Object.freeze(
    upload !== undefined &&
      tiles.drawKey === upload.drawKey &&
      tiles.bodyGeneration === upload.bodyGeneration &&
      tiles.zoneGeneration === upload.zoneGeneration &&
      tiles.viewIdentity === upload.viewIdentity &&
      tiles.bytes === upload.bytes &&
      tiles.coverageBytes === upload.coverageBytes &&
      tiles.layout === upload.layout &&
      tiles.transitionTargets === draw.transitionTargets &&
      waterBodyOwnerKey(
        tiles.worldIdentity,
        tiles.bodyGuid,
        tiles.bodyGeneration,
        tiles.zoneGeneration,
      ) === upload.bodyGuid
      ? retainUpload(tiles, upload)
      : tiles,
  );
}

export function waterMeshAdmissionUpload(tiles: WaterMeshTiles): WaterMeshInstanceDrawUpload {
  return (tiles as WithUpload)[OWNED_DRAW_UPLOAD] ?? normalizeUpload(tiles);
}

export function isOwnedWaterMeshAdmissionUpload(upload: WaterMeshInstanceDrawUpload): boolean {
  return (upload as { readonly [OWNED_UPLOAD]?: object })[OWNED_UPLOAD] === upload;
}

export function isOwnedWaterMeshAdmissionUploadClosure(
  uploads: readonly WaterMeshInstanceDrawUpload[],
): boolean {
  return (uploads as { readonly [OWNED_UPLOAD_CLOSURE]?: true })[OWNED_UPLOAD_CLOSURE] === true;
}
