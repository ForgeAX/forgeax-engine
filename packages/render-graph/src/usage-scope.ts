import { rangesOverlap } from './pass-access.js';
import type { GraphAccessUsage, GraphTextureContentRange } from './types.js';

/** Links follow declaration order within a physical resource in this pass. */
export interface ScopeAccess {
  nextOfResource?: number;
  resourceFollower?: true;
  readonly write: boolean;
  readonly usage: GraphAccessUsage;
  readonly range?: GraphTextureContentRange | undefined;
}

type TextureAccess = ScopeAccess & { readonly range: GraphTextureContentRange };

export interface ScopeWorkspace {
  texture?: { ordered: TextureAccess[]; groups: TextureAccess[][] };
}

function role(access: ScopeAccess): number {
  if (!access.write) return 0;
  if (access.usage === 'storage-read-write') return 1;
  if (access.usage === 'sampled-storage-read-write') return 2;
  return 3;
}

function incompatible(left: number, right: number): boolean {
  return left !== right || left === 3;
}

/** Sweep backwards by start coordinate. Each role's tail is the nearest later
 * start. Only incompatible intervals reaching this view can overlap it. */
function textureConflict(
  accesses: readonly ScopeAccess[],
  first: number,
  workspace: ScopeWorkspace,
): boolean {
  workspace.texture ??= { ordered: [], groups: [[], [], [], []] };
  const { ordered, groups } = workspace.texture;
  let mipMin = Infinity,
    mipMax = 0,
    mips = 0;
  let layerMin = Infinity,
    layerMax = 0,
    layers = 0;
  for (let i: number | undefined = first; i !== undefined; ) {
    const access = accesses[i] as TextureAccess;
    const r = access.range;
    mipMin = Math.min(mipMin, r.mipStart);
    mipMax = Math.max(mipMax, r.mipEnd);
    mips += r.mipEnd - r.mipStart;
    layerMin = Math.min(layerMin, r.layerStart);
    layerMax = Math.max(layerMax, r.layerEnd);
    layers += r.layerEnd - r.layerStart;
    ordered.push(access);
    i = access.nextOfResource;
  }
  const byLayer = layers * (mipMax - mipMin) <= mips * (layerMax - layerMin);
  const start = byLayer ? 'layerStart' : 'mipStart';
  const end = byLayer ? 'layerEnd' : 'mipEnd';
  ordered.sort((a, b) => b.range[start] - a.range[start]);
  let conflict = false;
  sweep: for (const access of ordered) {
    const range = access.range;
    const current = role(access);
    for (let r = 0; r < groups.length; r++) {
      if (!incompatible(current, r)) continue;
      const group = groups[r] as TextureAccess[];
      for (let i = group.length - 1; i >= 0; i--) {
        const other = (group[i] as TextureAccess).range;
        if (other[start] >= range[end]) break;
        if (rangesOverlap(range, other)) {
          conflict = true;
          break sweep;
        }
      }
    }
    (groups[current] as TextureAccess[]).push(access);
  }
  ordered.length = 0;
  for (const group of groups) group.length = 0;
  return conflict;
}

/** Keep short and homogeneous declarations allocation free. Sorting is only
 * needed for a resource with both potentially conflicting roles and many views. */
function resourceMayConflict(
  accesses: readonly ScopeAccess[],
  head: number,
  workspace: ScopeWorkspace,
): boolean {
  const first = accesses[head] as ScopeAccess;
  const firstRole = role(first);
  let count = 1;
  let mixed = false;
  for (let i = first.nextOfResource; i !== undefined; ) {
    const other = accesses[i] as ScopeAccess;
    mixed ||= incompatible(firstRole, role(other));
    count++;
    i = other.nextOfResource;
  }
  if (!mixed) return false;
  return count <= 8 || first.range === undefined || textureConflict(accesses, head, workspace);
}

export function firstScopeConflict<T extends ScopeAccess>(
  accesses: readonly T[],
  workspace: ScopeWorkspace,
): readonly [T, T] | undefined {
  let earliest = accesses.length;
  let partner = -1;
  for (let head = 0; head < earliest; head++) {
    const first = accesses[head] as ScopeAccess;
    if (first.resourceFollower || first.nextOfResource === undefined) continue;
    if (!resourceMayConflict(accesses, head, workspace)) continue;
    // Keep declaration-order diagnostics even when physical or sweep order differs.
    for (let i: number | undefined = head; i !== undefined && i < earliest; ) {
      const left = accesses[i] as T;
      const leftRole = role(left);
      for (let j = left.nextOfResource; j !== undefined; ) {
        const right = accesses[j] as T;
        if (incompatible(leftRole, role(right)) && rangesOverlap(left.range, right.range)) {
          earliest = i;
          partner = j;
          break;
        }
        j = right.nextOfResource;
      }
      i = left.nextOfResource;
    }
  }
  return partner < 0 ? undefined : [accesses[earliest] as T, accesses[partner] as T];
}
