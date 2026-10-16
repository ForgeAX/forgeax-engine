import { gpuDrivenShadowDrawKey } from '../extract/gpu-driven';
import type { RenderResourceScope } from '../publication/resource-scope';
import { worldEntityKey } from '../record/frame-snapshot';
import {
  publishedShadowMembershipKeys,
  publishShadowMembership,
  shadowMembershipLookup,
} from '../record/shadow-ownership-index';
import type {
  DispatchEntry,
  RenderableSnapshot,
  ShadowCasterMembership,
} from '../render-system-extract';

const WORLD_ENTITY_KEY_STRIDE = 4294967296;

/**
 * Extract emits world/entity keys in the transient `worlds[]` index domain,
 * while PersistentRenderScene owns stable renderer-local RenderResourceScope keys for the
 * retained GPU scene. Rebase ShadowCaster ownership at this orchestration
 * boundary before both GPU projection and CPU residual recording consume it.
 */
export function rebaseShadowCasterOwnership(
  worlds: readonly RenderResourceScope[],
  stableWorldKeys: readonly number[],
  entityKeys: ReadonlySet<number>,
  drawKeys: ReadonlySet<string>,
  membership: readonly ShadowCasterMembership[] | undefined,
): {
  readonly entityKeys: ReadonlySet<number>;
  readonly drawKeys: ReadonlySet<string>;
  readonly membership: readonly ShadowCasterMembership[] | undefined;
} {
  let sameWorldKeys = true;
  for (let index = 0; index < worlds.length; index += 1) {
    if ((stableWorldKeys[index] ?? index) !== index) {
      sameWorldKeys = false;
      break;
    }
  }
  const rebaseWorldEntity = (composite: number): number => {
    const transientWorldId = Math.floor(composite / WORLD_ENTITY_KEY_STRIDE);
    if (
      !Number.isInteger(transientWorldId) ||
      transientWorldId < 0 ||
      transientWorldId >= worlds.length
    ) {
      return composite;
    }
    const entityKey = composite - transientWorldId * WORLD_ENTITY_KEY_STRIDE;
    return worldEntityKey(stableWorldKeys[transientWorldId] ?? transientWorldId, entityKey);
  };

  let stableMembership = membership;
  if (membership !== undefined && !sameWorldKeys) {
    const producerOwned = publishedShadowMembershipKeys(membership) !== undefined;
    const remapped = membership.map((entry) => {
      const captured = { ...entry, worldEntity: rebaseWorldEntity(entry.worldEntity) };
      return producerOwned ? Object.freeze(captured) : captured;
    });
    stableMembership = producerOwned ? publishShadowMembership(remapped) : remapped;
  }
  // Draw keys still derive from membership (or normalize the legacy strings),
  // even when the numeric world mapping needs no copies.
  const stableDrawKeys =
    stableMembership === undefined
      ? new Set(
          [...drawKeys].map((key) => {
            const parts = key.split(':');
            if (parts.length !== 4) return key;
            const transientWorldEntity = Number(parts[0]);
            if (!Number.isFinite(transientWorldEntity)) return key;
            return `${rebaseWorldEntity(transientWorldEntity)}:${parts[1]}:${parts[2]}:${parts[3]}`;
          }),
        )
      : publishedShadowMembershipKeys(stableMembership) !== undefined
        ? shadowMembershipLookup(stableMembership).keySet
        : new Set(
            stableMembership.map((entry) =>
              gpuDrivenShadowDrawKey(
                entry.worldEntity,
                entry.materialHandle,
                entry.drawItemIndex,
                entry.passIndex,
              ),
            ),
          );
  return {
    entityKeys: sameWorldKeys ? entityKeys : new Set([...entityKeys].map(rebaseWorldEntity)),
    drawKeys: stableDrawKeys,
    membership: stableMembership,
  };
}

type ShadowCasterPass = NonNullable<RenderableSnapshot['shadowCasterPasses']>[number];

export interface ShadowCasterOwnership {
  readonly entityKeys: ReadonlySet<number>;
  readonly drawKeys: ReadonlySet<string>;
  readonly membership: readonly ShadowCasterMembership[];
}

function samePass(left: ShadowCasterPass, right: ShadowCasterPass): boolean {
  return (
    left === right ||
    (left.drawItemIndex === right.drawItemIndex &&
      left.materialHandle === right.materialHandle &&
      left.passIndex === right.passIndex &&
      left.materialShaderId === right.materialShaderId &&
      left.vertexEntry === right.vertexEntry &&
      left.fragmentEntry === right.fragmentEntry &&
      left.cpuReason === right.cpuReason &&
      left.gpuDrivenEligible === right.gpuDrivenEligible &&
      (left.renderState === right.renderState ||
        JSON.stringify(left.renderState ?? null) === JSON.stringify(right.renderState ?? null)))
  );
}

function samePasses(
  left: readonly ShadowCasterPass[] | undefined,
  right: readonly ShadowCasterPass[] | undefined,
): boolean {
  if (left === right) return true;
  const leftLength = left?.length ?? 0;
  if (leftLength !== (right?.length ?? 0)) return false;
  for (let index = 0; index < leftLength; index += 1) {
    const leftPass = left?.[index];
    const rightPass = right?.[index];
    if (leftPass === undefined || rightPass === undefined || !samePass(leftPass, rightPass)) {
      return false;
    }
  }
  return true;
}

interface OwnershipSourceRow {
  readonly worldId: number;
  readonly entityKey: number;
  readonly visible: boolean;
  readonly passes: readonly ShadowCasterPass[] | undefined;
}

/**
 * Retained ShadowCaster ownership over the persistent scene rows. Transform,
 * bounds, and temporal changes rebuild snapshots without changing ownership,
 * so the projection compares only the ownership facts and returns the previous
 * immutable result when they match. Identity equality of the result is the
 * membership revision consumed by the GPU producer and CPU residual.
 */
export class ShadowCasterOwnershipProjection {
  private rows: OwnershipSourceRow[] = [];
  private readonly retainedDrawKeys = new WeakMap<ShadowCasterMembership, string>();
  private dispatch: readonly DispatchEntry[] | undefined;
  private shadowDispatchRows: readonly number[] = [];
  private value: ShadowCasterOwnership | undefined;
  private builds = 0;
  private rowBuilds = 0;

  project(
    renderables: readonly RenderableSnapshot[],
    dispatch: readonly DispatchEntry[],
  ): ShadowCasterOwnership {
    const changedRow = this.value === undefined ? 0 : this.changedRowIndex(renderables, dispatch);
    if (changedRow < 0 && this.value !== undefined) return this.value;
    const rows = changedRow === 0 ? [] : this.rows.slice(0, changedRow);
    const entityKeys = new Set<number>();
    const drawKeys = new Set<string>();
    const previousMembership = this.value?.membership ?? [];
    const previousCapturedKeys = publishedShadowMembershipKeys(previousMembership);
    const capturedKeys: string[] = [];
    let sameKeys = true;
    // Membership is ordered by renderable index. Reuse its proven prefix
    // without retaining another key array or a per-row membership cache.
    let prefixEnd = 0;
    let right = changedRow === 0 ? 0 : previousMembership.length;
    while (prefixEnd < right) {
      const middle = (prefixEnd + right) >>> 1;
      const member = previousMembership[middle];
      if (member !== undefined && member.renderableIndex < changedRow) prefixEnd = middle + 1;
      else right = middle;
    }
    const membership = prefixEnd === 0 ? [] : previousMembership.slice(0, prefixEnd);
    for (let index = 0; index < membership.length; index++) {
      const member = membership[index];
      if (member === undefined) throw Error('Missing retained shadow membership');
      entityKeys.add(member.worldEntity);
      let key = this.retainedDrawKeys.get(member);
      if (key === undefined) {
        key = gpuDrivenShadowDrawKey(
          member.worldEntity,
          member.materialHandle,
          member.drawItemIndex,
          member.passIndex,
        );
        this.retainedDrawKeys.set(member, key);
      }
      drawKeys.add(key);
      const capturedKey =
        previousCapturedKeys?.[index] ??
        gpuDrivenShadowDrawKey(
          member.worldEntity,
          member.materialHandle,
          member.drawItemIndex,
          member.passIndex,
        );
      capturedKeys.push(capturedKey);
      sameKeys &&= capturedKey === key;
    }
    for (
      let renderableIndex = changedRow;
      renderableIndex < renderables.length;
      renderableIndex += 1
    ) {
      const snapshot = renderables[renderableIndex];
      if (snapshot === undefined) continue;
      const visible = snapshot.authorVisible !== false;
      rows.push({
        worldId: snapshot.worldId,
        entityKey: snapshot.entityKey,
        visible,
        passes: snapshot.shadowCasterPasses,
      });
      if (!visible) continue;
      const worldEntity = worldEntityKey(snapshot.worldId, snapshot.entityKey);
      for (const pass of snapshot.shadowCasterPasses ?? []) {
        const captured = Object.freeze({ ...pass, worldEntity, renderableIndex });
        membership.push(captured);
        entityKeys.add(worldEntity);
        // Keep the original second raw observation; owned POD usually agrees
        // and shares this key with the consumer index instead of formatting it twice.
        const materialHandle = pass.materialHandle;
        const drawItemIndex = pass.drawItemIndex;
        const passIndex = pass.passIndex;
        const key = gpuDrivenShadowDrawKey(worldEntity, materialHandle, drawItemIndex, passIndex);
        this.retainedDrawKeys.set(captured, key);
        drawKeys.add(key);
        const equal =
          captured.materialHandle === materialHandle &&
          captured.drawItemIndex === drawItemIndex &&
          captured.passIndex === passIndex;
        sameKeys &&= equal;
        capturedKeys.push(
          equal
            ? key
            : gpuDrivenShadowDrawKey(
                worldEntity,
                captured.materialHandle,
                captured.drawItemIndex,
                captured.passIndex,
              ),
        );
      }
    }
    this.rowBuilds += rows.length - changedRow;
    const shadowDispatchRows: number[] = [];
    for (const draw of dispatch) {
      if (draw.tags.LightMode !== 'ShadowCaster') continue;
      shadowDispatchRows.push(draw.renderableIndex);
      const snapshot = renderables[draw.renderableIndex];
      if (snapshot !== undefined)
        entityKeys.add(worldEntityKey(snapshot.worldId, snapshot.entityKey));
    }
    this.rows = rows;
    this.dispatch = dispatch;
    this.shadowDispatchRows = shadowDispatchRows;
    const ownedMembership = publishShadowMembership(
      membership,
      capturedKeys,
      sameKeys ? drawKeys : undefined,
    );
    this.value = Object.freeze({ entityKeys, drawKeys, membership: ownedMembership });
    this.builds += 1;
    return this.value;
  }

  /** Number of ownership rebuilds since construction; steady frames keep it flat. */
  buildCount(): number {
    return this.builds;
  }

  /** Source rows regenerated, excluding retained rows in a changed roster. */
  rowBuildCount(): number {
    return this.rowBuilds;
  }

  private sameRow(
    row: OwnershipSourceRow | undefined,
    snapshot: RenderableSnapshot,
  ): row is OwnershipSourceRow {
    return (
      row !== undefined &&
      snapshot.worldId === row.worldId &&
      snapshot.entityKey === row.entityKey &&
      (snapshot.authorVisible !== false) === row.visible &&
      samePasses(snapshot.shadowCasterPasses, row.passes)
    );
  }

  private changedRowIndex(
    renderables: readonly RenderableSnapshot[],
    dispatch: readonly DispatchEntry[],
  ): number {
    const count = Math.min(renderables.length, this.rows.length);
    for (let index = 0; index < count; index += 1) {
      const snapshot = renderables[index];
      const row = this.rows[index];
      if (snapshot === undefined || !this.sameRow(row, snapshot)) return index;
    }
    if (renderables.length !== this.rows.length) return count;
    if (dispatch === this.dispatch) return -1;
    let cursor = 0;
    for (const draw of dispatch) {
      if (draw.tags.LightMode !== 'ShadowCaster') continue;
      if (this.shadowDispatchRows[cursor] !== draw.renderableIndex) return count;
      cursor += 1;
    }
    if (cursor !== this.shadowDispatchRows.length) return count;
    this.dispatch = dispatch;
    return -1;
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Retains the stable-key rebase so an unchanged ownership keeps its identity. */
export class ShadowCasterOwnershipRebase {
  private worldCount = -1;
  private stableWorldKeys: readonly number[] = [];
  private entityKeys: ReadonlySet<number> | undefined;
  private drawKeys: ReadonlySet<string> | undefined;
  private membership: readonly ShadowCasterMembership[] | undefined;
  private value: ReturnType<typeof rebaseShadowCasterOwnership> | undefined;

  rebase(
    worlds: readonly RenderResourceScope[],
    stableWorldKeys: readonly number[],
    entityKeys: ReadonlySet<number>,
    drawKeys: ReadonlySet<string>,
    membership: readonly ShadowCasterMembership[] | undefined,
  ): ReturnType<typeof rebaseShadowCasterOwnership> {
    if (
      this.value !== undefined &&
      this.worldCount === worlds.length &&
      this.entityKeys === entityKeys &&
      this.drawKeys === drawKeys &&
      this.membership === membership &&
      sameNumbers(this.stableWorldKeys, stableWorldKeys)
    ) {
      return this.value;
    }
    this.worldCount = worlds.length;
    this.stableWorldKeys = [...stableWorldKeys];
    this.entityKeys = entityKeys;
    this.drawKeys = drawKeys;
    this.membership = membership;
    this.value = rebaseShadowCasterOwnership(
      worlds,
      stableWorldKeys,
      entityKeys,
      drawKeys,
      membership,
    );
    return this.value;
  }
}
