import { gpuDrivenShadowDrawKey } from '../extract/gpu-driven';
import type { RenderableSnapshot, ShadowCasterMembership } from '../render-system-extract';
import { type EntryLookup, FirstEntryMap } from './first-entry-map';

interface ShadowMembershipDraw {
  readonly rows: readonly number[];
  readonly cpu: boolean;
}

/**
 * Numeric lookup over one ShadowCaster membership array. The array identity
 * is stable while membership is unchanged, so every view and frame reuses one
 * index instead of formatting draw keys per submesh.
 */
export interface ShadowMembershipLookup {
  readonly keys: readonly string[];
  readonly keySet: ReadonlySet<string>;
  readonly draws: ReadonlyMap<
    number,
    EntryLookup<number, EntryLookup<number, ShadowMembershipDraw>>
  >;
}

const lookups = new WeakMap<
  readonly ShadowCasterMembership[],
  ShadowMembershipLookup & { readonly producerOwned: boolean }
>();

export function shadowMembershipLookup(
  membership: readonly ShadowCasterMembership[],
): ShadowMembershipLookup {
  const cached = lookups.get(membership);
  if (cached !== undefined) return cached;
  const lookup = buildShadowMembershipLookup(membership);
  lookups.set(membership, lookup);
  return lookup;
}

/** Complete the producer's captured POD membership and its single shared draw-key index. */
export function publishShadowMembership(
  membership: ShadowCasterMembership[],
  capturedKeys?: string[],
  keySet?: ReadonlySet<string>,
): readonly ShadowCasterMembership[] {
  const owned = Object.freeze(membership);
  lookups.set(owned, buildShadowMembershipLookup(owned, capturedKeys, keySet, true));
  return owned;
}

export function publishedShadowMembershipKeys(
  membership: readonly ShadowCasterMembership[],
): readonly string[] | undefined {
  const lookup = lookups.get(membership);
  return lookup?.producerOwned ? lookup.keys : undefined;
}

function buildShadowMembershipLookup(
  membership: readonly ShadowCasterMembership[],
  capturedKeys?: string[],
  capturedSet?: ReadonlySet<string>,
  producerOwned = false,
): ShadowMembershipLookup & { readonly producerOwned: boolean } {
  const keys: string[] = capturedKeys ?? [];
  const draws = new Map<
    number,
    FirstEntryMap<number, FirstEntryMap<number, { rows: number[]; cpu: boolean }>>
  >();
  for (let row = 0; row < membership.length; row++) {
    const entry = membership[row];
    if (entry === undefined) continue;
    if (capturedKeys === undefined)
      keys.push(
        gpuDrivenShadowDrawKey(
          entry.worldEntity,
          entry.materialHandle,
          entry.drawItemIndex,
          entry.passIndex,
        ),
      );
    let byMaterial = draws.get(entry.worldEntity);
    if (byMaterial === undefined) {
      byMaterial = new FirstEntryMap();
      draws.set(entry.worldEntity, byMaterial);
    }
    let byDraw = byMaterial.get(entry.materialHandle);
    if (byDraw === undefined) {
      byDraw = new FirstEntryMap();
      byMaterial.set(entry.materialHandle, byDraw);
    }
    let draw = byDraw.get(entry.drawItemIndex);
    if (draw === undefined) {
      draw = { rows: [], cpu: false };
      byDraw.set(entry.drawItemIndex, draw);
    }
    draw.rows.push(row);
    if (entry.cpuReason !== undefined) draw.cpu = true;
  }
  const lookup = Object.freeze({
    keys: producerOwned ? Object.freeze(keys) : keys,
    keySet: capturedSet ?? new Set(keys),
    draws,
    producerOwned,
  });
  return lookup;
}

export function shadowMembershipDraw(
  lookup: ShadowMembershipLookup,
  worldEntity: number,
  materialHandle: number,
  drawItemIndex: number,
): ShadowMembershipDraw | undefined {
  return lookup.draws.get(worldEntity)?.get(materialHandle)?.get(drawItemIndex);
}

const sourcesByRenderable = new WeakMap<
  readonly { readonly renderableIndex: number; readonly source: RenderableSnapshot }[],
  ReadonlyMap<number, RenderableSnapshot>
>();

/** Shared by every shadow view of one recorded frame. */
export function shadowSourcesByRenderable(
  ordered: readonly { readonly renderableIndex: number; readonly source: RenderableSnapshot }[],
): ReadonlyMap<number, RenderableSnapshot> {
  const cached = sourcesByRenderable.get(ordered);
  if (cached !== undefined) return cached;
  const sources = new Map<number, RenderableSnapshot>();
  for (const entry of ordered) sources.set(entry.renderableIndex, entry.source);
  sourcesByRenderable.set(ordered, sources);
  return sources;
}
