import type { MaterialRenderState } from '@forgeax/engine-types';
import {
  gpuDrivenDrawKey,
  gpuDrivenShadowDrawKey,
  gpuDrivenSourceDrawItemIndex,
} from '../extract/gpu-driven';
import { supportsGpuShadowRenderState } from '../material-render-state';
import { FirstEntryMap } from '../record/first-entry-map';
import { worldEntityKey } from '../record/frame-snapshot';
import {
  publishedShadowMembershipKeys,
  type ShadowMembershipLookup,
  shadowMembershipDraw,
  shadowMembershipLookup,
} from '../record/shadow-ownership-index';
import type { RenderableSnapshot, ShadowCasterMembership } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { GpuDrivenBatch } from './batch-topology';

export function sourceDrawForCandidate(
  slot: PersistentGpuDrivenState['slots'][number],
  candidate: Pick<GpuDrivenBatch['candidates'][number], 'drawItemIndex'>,
): NonNullable<RenderableSnapshot['gpuDrivenDraws']>[number] | undefined {
  // Draw metadata can be borrowed. Preserve the source lookup and its earlier
  // observations before admitting or caching a candidate claim.
  return slot.snapshot.gpuDrivenDraws?.find(
    (draw, compactIndex) =>
      gpuDrivenSourceDrawItemIndex(draw, compactIndex) === candidate.drawItemIndex,
  );
}

// GPU shadow ownership addresses entities and draw items, never a display
// frame's transient renderable-array position.
type ShadowCasterFact = Omit<ShadowCasterMembership, 'renderableIndex'>;

type MutableShadowClaim = {
  keys: string[];
  compatible: boolean;
  readonly entry: ShadowCasterFact | undefined;
};

type ShadowMembershipIndex = ReadonlyMap<number, readonly ShadowCandidateClaim[]>;

// A bucket hash, never a unique draw identity. Full numeric facts disambiguate
// collisions, including large handles whose low 32 bits coincide.
function shadowDrawHash(
  worldEntity: number,
  materialHandle: number,
  drawItemIndex: number,
): number {
  let hash = Math.imul(worldEntity | 0, 0x9e3779b1);
  hash = Math.imul(hash ^ Math.floor(worldEntity / 4294967296), 0x85ebca6b);
  return Math.imul(hash ^ materialHandle, 0xc2b2ae35) ^ drawItemIndex;
}

function sameIdentity(left: number, right: number): boolean {
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

function claimForDraw<T extends ShadowCandidateClaim>(
  bucket: readonly T[] | undefined,
  worldEntity: number,
  materialHandle: number,
  drawItemIndex: number,
): T | undefined {
  if (bucket === undefined) return undefined;
  for (const claim of bucket) {
    const entry = claim.entry;
    if (
      entry !== undefined &&
      sameIdentity(entry.worldEntity, worldEntity) &&
      sameIdentity(entry.materialHandle, materialHandle) &&
      sameIdentity(entry.drawItemIndex, drawItemIndex)
    )
      return claim;
  }
  return undefined;
}

function buildShadowMembershipIndex(membership: readonly ShadowCasterFact[]): {
  readonly index: ShadowMembershipIndex;
  readonly casterKeys: ReadonlySet<string>;
} {
  const index = new Map<number, MutableShadowClaim[]>();
  const ordered: MutableShadowClaim[] = [];
  for (const entry of membership) {
    const hash = shadowDrawHash(entry.worldEntity, entry.materialHandle, entry.drawItemIndex);
    const bucket = index.get(hash);
    let claim = claimForDraw(bucket, entry.worldEntity, entry.materialHandle, entry.drawItemIndex);
    if (claim === undefined) {
      const compatible =
        entry.cpuReason === undefined &&
        supportsGpuShadowRenderState(entry.renderState) &&
        entry.gpuDrivenEligible !== false;
      claim = {
        keys: [
          gpuDrivenShadowDrawKey(
            entry.worldEntity,
            entry.materialHandle,
            entry.drawItemIndex,
            entry.passIndex,
          ),
        ],
        compatible,
        entry,
      };
      if (bucket === undefined) index.set(hash, [claim]);
      else bucket.push(claim);
      ordered.push(claim);
    } else {
      claim.compatible = false;
      claim.keys.push(
        gpuDrivenShadowDrawKey(
          entry.worldEntity,
          entry.materialHandle,
          entry.drawItemIndex,
          entry.passIndex,
        ),
      );
    }
  }
  const casterKeys = new Set<string>();
  // Preserve first-seen draw-group order even when entities are interleaved.
  for (const claim of ordered) {
    if (claim.keys.length > 1) claim.keys = [...new Set(claim.keys)];
    if (claim.keys.length !== 1) claim.compatible = false;
    Object.freeze(claim.keys);
    Object.freeze(claim);
    for (const key of claim.keys) casterKeys.add(key);
  }
  return { index, casterKeys };
}

/** Index immutable shadow ownership once for every candidate and cascade lookup. */
function buildLegacyShadowMembershipIndex(
  shadowCasterDrawKeys: ReadonlySet<string> | undefined,
): ReadonlyMap<string, ShadowCandidateClaim> | undefined {
  if (shadowCasterDrawKeys === undefined) return undefined;
  const byDraw = new Map<string, MutableShadowClaim>();
  const add = (base: string, key: string) => {
    let claim = byDraw.get(base);
    if (claim === undefined) {
      claim = {
        keys: [],
        compatible: true,
        entry: undefined,
      };
      byDraw.set(base, claim);
    }
    claim.keys.push(key);
  };
  for (const key of shadowCasterDrawKeys) {
    const parts = key.split(':');
    if (parts.length !== 4) continue;
    add(parts.slice(0, 3).join(':'), key);
  }
  for (const claim of byDraw.values()) {
    if (claim.keys.length > 1) claim.keys = [...new Set(claim.keys)];
    if (claim.keys.length !== 1) claim.compatible = false;
    Object.freeze(claim.keys);
    Object.freeze(claim);
  }
  return byDraw;
}

export interface ShadowCandidateClaim {
  /** Shadow draw keys this candidate would claim for the GPU lane. */
  readonly keys: readonly string[];
  readonly compatible: boolean;
  readonly entry: ShadowCasterFact | undefined;
}

const NO_SHADOW_CLAIM: ShadowCandidateClaim = Object.freeze({
  keys: Object.freeze([]),
  compatible: false,
  entry: undefined,
});

function snapshotShadowBlend(value: GPUBlendState): GPUBlendState {
  return Object.freeze({
    color: Object.freeze({ ...value.color }),
    alpha: Object.freeze({ ...value.alpha }),
  });
}

function snapshotShadowRenderState(state: MaterialRenderState): MaterialRenderState {
  return Object.freeze({
    ...state,
    ...(state.blend === undefined ? {} : { blend: snapshotShadowBlend(state.blend) }),
    ...(state.stencil === undefined ? {} : { stencil: Object.freeze({ ...state.stencil }) }),
    ...(state.outputs === undefined
      ? {}
      : {
          outputs: Object.freeze(
            state.outputs.map((output) =>
              Object.freeze({
                ...output,
                ...(output.blend === undefined ? {} : { blend: snapshotShadowBlend(output.blend) }),
              }),
            ),
          ),
        }),
  });
}

function sameShadowStateValue(
  before: MaterialRenderState[keyof MaterialRenderState],
  after: MaterialRenderState[keyof MaterialRenderState],
): boolean {
  return (
    before === after ||
    (typeof before === 'object' &&
      typeof after === 'object' &&
      JSON.stringify(before) === JSON.stringify(after))
  );
}

function sameShadowRenderState(
  left: MaterialRenderState | undefined,
  right: MaterialRenderState | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  // The GPU lane consumes scalar raster state. Nested color/stencil state is
  // retained too, but only the rejected CPU lane needs that slower comparison.
  for (const key in left) {
    const field = key as keyof MaterialRenderState;
    if (!sameShadowStateValue(left[field], right[field])) return false;
  }
  for (const key in right) {
    const field = key as keyof MaterialRenderState;
    if (!(key in left) && !sameShadowStateValue(left[field], right[field])) return false;
  }
  return true;
}

/**
 * Owns immutable membership facts and their candidate index. Equivalent
 * publications retain this table, so every instance and view shares the same
 * claim without serializing a world-sized signature or repeating claim checks.
 */
export class ShadowClaimTable {
  private readonly bySnapshot = new WeakMap<
    RenderableSnapshot,
    FirstEntryMap<number, ShadowCandidateClaim>
  >();
  private readonly membership: readonly ShadowCasterFact[] | undefined;
  private readonly index: ShadowMembershipIndex | undefined;
  private readonly legacyIndex: ReadonlyMap<string, ShadowCandidateClaim> | undefined;
  private readonly numericMembership: ShadowMembershipLookup | undefined;
  private readonly rowClaims: readonly ShadowCandidateClaim[] | undefined;
  readonly casterKeys: ReadonlySet<string> | undefined;

  constructor(
    drawKeys: ReadonlySet<string> | undefined,
    membership: readonly ShadowCasterMembership[] | undefined,
  ) {
    this.membership =
      membership === undefined
        ? undefined
        : Object.freeze(
            membership.map((entry) => {
              // Finish borrowed source observations in spread order before
              // removing the frame-local position from the captured GPU facts.
              const observed = { ...entry };
              // Rest keeps fixed property layouts; deleting a middle field
              // puts every captured fact into V8's dictionary representation.
              const { renderableIndex: _position, ...captured } = observed;
              if (entry.renderState !== undefined)
                Object.assign(captured, {
                  renderState: snapshotShadowRenderState(entry.renderState),
                });
              return Object.freeze(captured);
            }),
          );
    const capturedKeys =
      membership === undefined ? undefined : publishedShadowMembershipKeys(membership);
    this.numericMembership =
      capturedKeys === undefined || membership === undefined
        ? undefined
        : shadowMembershipLookup(membership);
    const publishedClaims =
      this.numericMembership === undefined ||
      this.membership === undefined ||
      capturedKeys === undefined
        ? undefined
        : buildPublishedShadowClaims(this.membership, this.numericMembership, capturedKeys);
    this.rowClaims = publishedClaims?.claims;
    if (publishedClaims !== undefined) {
      this.index = undefined;
      this.legacyIndex = undefined;
      this.casterKeys = publishedClaims.casterKeys;
    } else if (this.membership === undefined) {
      this.index = undefined;
      this.legacyIndex = buildLegacyShadowMembershipIndex(drawKeys);
      this.casterKeys = drawKeys === undefined ? undefined : new Set(drawKeys);
    } else {
      const built = buildShadowMembershipIndex(this.membership);
      this.index = built.index;
      this.legacyIndex = undefined;
      this.casterKeys = built.casterKeys;
    }
  }

  matches(
    drawKeys: ReadonlySet<string> | undefined,
    membership: readonly ShadowCasterMembership[] | undefined,
  ): boolean {
    if (this.membership === undefined || membership === undefined) {
      if (this.membership !== membership) return false;
      if (this.casterKeys === undefined || drawKeys === undefined)
        return this.casterKeys === drawKeys;
      if (this.casterKeys.size !== drawKeys.size) return false;
      for (const key of drawKeys) if (!this.casterKeys.has(key)) return false;
      return true;
    }
    // Membership is authoritative when supplied; the legacy key set is unused.
    if (this.membership.length !== membership.length) return false;
    for (let index = 0; index < membership.length; index += 1) {
      const before = this.membership[index];
      const after = membership[index];
      if (before === undefined || after === undefined || before.worldEntity !== after.worldEntity)
        return false;
      // Observe the borrowed position at its original boundary without making
      // a transient display-array position part of GPU ownership identity.
      void after.renderableIndex;
      if (
        before.drawItemIndex !== after.drawItemIndex ||
        before.materialHandle !== after.materialHandle ||
        before.passIndex !== after.passIndex ||
        before.materialShaderId !== after.materialShaderId ||
        before.vertexEntry !== after.vertexEntry ||
        before.fragmentEntry !== after.fragmentEntry ||
        before.cpuReason !== after.cpuReason ||
        before.gpuDrivenEligible !== after.gpuDrivenEligible ||
        !sameShadowRenderState(before.renderState, after.renderState)
      )
        return false;
    }
    return true;
  }

  claim(
    slot: PersistentGpuDrivenState['slots'][number],
    candidate: Pick<GpuDrivenBatch['candidates'][number], 'drawItemIndex'>,
  ): ShadowCandidateClaim {
    let byDraw = this.bySnapshot.get(slot.snapshot);
    if (byDraw === undefined) {
      byDraw = new FirstEntryMap();
      this.bySnapshot.set(slot.snapshot, byDraw);
    }
    const cached = byDraw.get(candidate.drawItemIndex);
    return cached ?? this.resolveClaim(slot, candidate, byDraw);
  }

  private resolveClaim(
    slot: PersistentGpuDrivenState['slots'][number],
    candidate: Pick<GpuDrivenBatch['candidates'][number], 'drawItemIndex'>,
    byDraw: FirstEntryMap<number, ShadowCandidateClaim>,
  ): ShadowCandidateClaim {
    const draw = sourceDrawForCandidate(slot, candidate);
    let claim = NO_SHADOW_CLAIM;
    if (draw !== undefined) {
      const material = slot.snapshot.materials[draw.materialSlot] ?? slot.snapshot.material;
      const worldEntity = worldEntityKey(slot.snapshot.worldId, slot.snapshot.entityKey);
      const materialHandle = material.materialHandle ?? -1;
      const drawItemIndex = candidate.drawItemIndex;
      if (this.numericMembership !== undefined && this.rowClaims !== undefined) {
        const row = shadowMembershipDraw(
          this.numericMembership,
          worldEntity,
          materialHandle,
          drawItemIndex,
        )?.rows[0];
        claim = (row === undefined ? undefined : this.rowClaims[row]) ?? NO_SHADOW_CLAIM;
      } else
        claim =
          (this.index === undefined
            ? this.legacyIndex?.get(gpuDrivenDrawKey(worldEntity, materialHandle, drawItemIndex))
            : claimForDraw(
                this.index.get(shadowDrawHash(worldEntity, materialHandle, drawItemIndex)),
                worldEntity,
                materialHandle,
                drawItemIndex,
              )) ?? NO_SHADOW_CLAIM;
    }
    byDraw.set(candidate.drawItemIndex, claim);
    return claim;
  }
}

/** Borrow the publication's numeric index instead of building a second string index. */
function buildPublishedShadowClaims(
  membership: readonly ShadowCasterFact[],
  lookup: ShadowMembershipLookup,
  capturedKeys: readonly string[],
): { readonly claims: readonly ShadowCandidateClaim[]; readonly casterKeys: ReadonlySet<string> } {
  const claims: ShadowCandidateClaim[] = [];
  const casterKeys = new Set<string>();
  for (let row = 0; row < membership.length; row++) {
    const entry = membership[row];
    if (entry === undefined) throw Error('Missing published shadow membership');
    const draw = shadowMembershipDraw(
      lookup,
      entry.worldEntity,
      entry.materialHandle,
      entry.drawItemIndex,
    );
    const first = draw?.rows[0];
    if (draw === undefined || first === undefined) throw Error('Missing published shadow draw');
    if (first !== row) {
      const claim = claims[first];
      if (claim === undefined) throw Error('Missing published shadow claim');
      claims.push(claim);
      continue;
    }
    const firstKey = capturedKeys[row];
    if (firstKey === undefined) throw Error('Missing published shadow key');
    const keys = Object.freeze(
      draw.rows.length === 1
        ? [firstKey]
        : [
            ...new Set(
              draw.rows.map((index) => {
                const key = capturedKeys[index];
                if (key === undefined) throw Error('Missing published shadow key');
                return key;
              }),
            ),
          ],
    );
    for (const key of keys) casterKeys.add(key);
    claims.push(
      Object.freeze({
        keys,
        compatible:
          draw.rows.length === 1 &&
          entry.cpuReason === undefined &&
          supportsGpuShadowRenderState(entry.renderState) &&
          entry.gpuDrivenEligible !== false,
        entry,
      }),
    );
  }
  return { claims: Object.freeze(claims), casterKeys };
}
