import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { type TerrainSurface, terrainSurfaceHeight } from '@forgeax/engine-terrain';
import { err, ok, type Result, type TerrainError, type TextureAsset } from '@forgeax/engine-types';
import type { RenderResourceScope } from '../publication/resource-scope.js';
import type { FrameReceipt } from '../render-contract.js';
import type { RenderableSnapshot } from '../render-system-extract.js';

export interface SubmittedTerrainSection {
  readonly worldId: number;
  readonly entity: number;
  readonly section: number;
  readonly asset: number;
  readonly sectionOrigin: readonly [number, number];
  readonly translation: readonly [number, number, number];
  readonly surface: TerrainSurface;
}
const frozenHeightBytes = new WeakMap<TextureAsset, Uint8Array>();

/** Own the actual packed bytes before mutable publication receiver maps can advance. */
export function captureSubmittedTerrain(
  sources: readonly RenderableSnapshot[],
  worlds: readonly RenderResourceScope[],
): readonly SubmittedTerrainSection[] {
  const sections: SubmittedTerrainSection[] = [];
  for (const source of sources) {
    const terrain = source.terrain,
      section = source.terrainSection;
    if (terrain === undefined || section === undefined || source.authorVisible === false) continue;
    const world = worlds[source.worldId],
      handle = terrain.heightTextures[section.index],
      data = terrain.asset.sections[section.index];
    if (world === undefined || handle === undefined || data === undefined)
      throw unavailable('source', 'complete recorded terrain closure');
    const texture = resolveAssetHandle<TextureAsset>(world, handle).unwrap();
    if (texture.kind !== 'texture' || texture.format !== 'rgba8unorm')
      throw unavailable('height', 'RGBA8 height mip bytes');
    let heights = frozenHeightBytes.get(texture);
    if (heights === undefined) {
      heights = new Uint8Array(texture.data);
      frozenHeightBytes.set(texture, heights);
    }
    sections.push({
      worldId: source.worldId,
      entity: source.entityKey,
      section: section.index,
      asset: Number(terrain.handle),
      sectionOrigin: [data.x, data.z],
      translation: [
        source.transform.world[12] ?? 0,
        source.transform.world[13] ?? 0,
        source.transform.world[14] ?? 0,
      ],
      surface: {
        vertices: terrain.asset.subsectionVertices,
        width: (terrain.asset.subsectionVertices - 1) * terrain.asset.spacing,
        lod: section.lod,
        neighbors: [...section.neighbors],
        heightRange: [...terrain.asset.heightRange],
        heights,
      },
    });
  }
  return sections;
}
function unavailable(field: string, expected: string): TerrainError {
  return {
    code: 'terrain-query-unavailable',
    expected,
    hint: 'use an accepted current-generation receipt and an explicitly identified view',
    detail: { field },
  };
}
interface ViewSections {
  readonly view: string;
  readonly sections: readonly SubmittedTerrainSection[];
}
const receiptData = new WeakMap<
  FrameReceipt,
  { readonly views: readonly ViewSections[]; readonly isCurrent: () => boolean }
>();

/** Eight submitted receipts per Renderer; this retains CPU facts, never backend resources. */
export function createTerrainReceiptOwner(isCurrent: (receipt: FrameReceipt) => boolean) {
  const order: FrameReceipt[] = [];
  return {
    register(receipt: FrameReceipt, views: readonly ViewSections[]): void {
      if (!views.some((view) => view.sections.length > 0)) return;
      receiptData.set(receipt, { views, isCurrent: () => isCurrent(receipt) });
      order.push(receipt);
      while (order.length > 8) {
        const expired = order.shift();
        if (expired) receiptData.delete(expired);
      }
    },
    clear(): void {
      for (const receipt of order) receiptData.delete(receipt);
      order.length = 0;
    },
  };
}

export interface SubmittedTerrainHeightRequest {
  readonly worldId: number;
  readonly entity: number;
  readonly x: number;
  readonly z: number;
  readonly view?: string;
  /** Optional replacement barrier: a held view or old root must not satisfy it. */
  readonly expectedAsset?: number;
}

/** Canonical height using the submitted bytes, topology, LOD and pose; GPU arithmetic may differ. */
export async function querySubmittedTerrainHeight(
  receipt: FrameReceipt,
  request: SubmittedTerrainHeightRequest,
): Promise<Result<number | undefined, TerrainError>> {
  if (
    !Number.isInteger(request.worldId) ||
    request.worldId < 0 ||
    !Number.isInteger(request.entity) ||
    ![request.x, request.z].every(Number.isFinite)
  )
    return err(unavailable('request', 'finite coordinates and integer source identities'));
  if (
    request.expectedAsset !== undefined &&
    (!Number.isSafeInteger(request.expectedAsset) || request.expectedAsset <= 0)
  )
    return err(unavailable('expectedAsset', 'a positive shared TerrainAsset identity'));
  const completed = await receipt.completed,
    record = receiptData.get(receipt);
  if (
    receipt.presentation !== 'ready' ||
    !completed.ok ||
    record === undefined ||
    !record.isCurrent()
  )
    return err(unavailable('receipt', 'a retained completed successful terrain receipt'));
  const views =
    request.view === undefined
      ? record.views
      : record.views.filter((view) => view.view === request.view);
  if (views.length !== 1)
    return err(
      unavailable('view', 'exactly one view; name the view when multiple views were composed'),
    );
  const view = views[0];
  if (view === undefined) return err(unavailable('view', 'one submitted view'));
  const sections = view.sections.filter(
    (section) => section.worldId === request.worldId && section.entity === request.entity,
  );
  if (sections.length === 0)
    return err(unavailable('entity', 'a terrain drawn in this receipt and view'));
  if (
    request.expectedAsset !== undefined &&
    sections.some((section) => section.asset !== request.expectedAsset)
  )
    return err(unavailable('asset', 'the requested terrain root actually drawn in this view'));
  for (const section of sections) {
    const height = terrainSurfaceHeight(
      section.surface,
      request.x,
      request.z,
      section.sectionOrigin,
      section.translation,
    );
    if (height !== undefined) return ok(height);
  }
  return ok(undefined);
}
