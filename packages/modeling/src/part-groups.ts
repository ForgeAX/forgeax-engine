import { err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import type { CornerChannelName, EditMesh, PartRole } from './mesh';
import { partRole } from './mesh';
import type { OpDiagnostic, RoleCounts } from './ops';
import type { FaceSelector } from './selectors';
import { checkSize, faceOwners, texture } from './uv-textures';

const DEFAULT_PREFIX = 'bake:';
const DEFAULT_ROLES: readonly PartRole[] = ['form', 'detail'];
const DEFAULT_SIZE = 1024;

/** One part of a bake group map: faces carrying `tag` (inside `where`) bake as group `group` (default: the tag). */
export interface PartGroup {
  readonly tag: string;
  readonly group?: string;
  readonly where?: FaceSelector;
}

export interface BakeGroupsOptions {
  /**
   * Parts in priority order: a face takes the first entry it matches, so a narrower entry
   * (`{ tag: 'house', group: 'trim', where }`) comes before the entry it carves out of.
   */
  readonly parts: readonly (string | PartGroup)[];
  /** Tag prefix of the bake groups; match `bakeMaps` `tags.groupPrefix` (default `'bake:'`). */
  readonly prefix?: string;
  /** Faces of these roles are grouped; `tool` faces never bake (default form and detail). */
  readonly roles?: readonly PartRole[];
}

export interface IdMapOptions {
  /** Group tag prefix (default `'bake:'`). */
  readonly prefix?: string;
  readonly channel?: CornerChannelName;
  /** Texture side in texels (default 1024). */
  readonly size?: number;
}

export interface IdMapGroup {
  readonly id: string;
  /** sRGB bytes of the group's color in the texture. */
  readonly color: readonly [number, number, number];
  readonly faces: number;
}

export interface IdMap {
  readonly texture: TextureAsset;
  readonly groups: readonly IdMapGroup[];
}

/**
 * Tag the faces of `ids` with `<prefix><group>` by the ordered part map. A face that already
 * carries a group tag keeps it (explicit tagging wins over the map), so the call is idempotent.
 */
export function assignBakeGroups(
  mesh: EditMesh,
  ids: readonly number[],
  options: BakeGroupsOptions,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const roles = options.roles ?? DEFAULT_ROLES;
  if (options.parts.length === 0 || prefix === '') {
    return err(
      modelingError(
        'model-invalid-argument',
        'parts lists at least one part and prefix is not empty',
        { parts: options.parts.length, prefix },
      ),
    );
  }
  const parts: { tag: number; name: string; group: string; where: Set<number> | undefined }[] = [];
  for (const entry of options.parts) {
    const part = typeof entry === 'string' ? { tag: entry } : entry;
    let where: Set<number> | undefined;
    if (part.where !== undefined) {
      const resolved = part.where.resolve(mesh);
      if (!resolved.ok) return resolved;
      where = new Set(resolved.value);
    }
    parts.push({
      tag: mesh.tagIndex(part.tag, false),
      name: part.tag,
      group: part.group ?? part.tag,
      where,
    });
  }
  const grouped = new Set<number>();
  for (const [t, name] of mesh.tagNames.entries()) if (name.startsWith(prefix)) grouped.add(t);
  const counts: RoleCounts = {};
  const empty = new Set(parts.map((p) => p.name));
  let kept = 0;
  let untagged = 0;
  for (const f of ids) {
    if (!roles.includes(partRole(mesh, f))) continue;
    if ([...grouped].some((t) => mesh.hasTag(f, t))) {
      kept++;
      continue;
    }
    const part = parts.find(
      (p) => p.tag >= 0 && mesh.hasTag(f, p.tag) && (p.where === undefined || p.where.has(f)),
    );
    if (part === undefined) {
      untagged++;
      continue;
    }
    empty.delete(part.name);
    mesh.addTag(f, mesh.tagIndex(prefix + part.group, true));
    counts[part.group] = (counts[part.group] ?? 0) + 1;
  }
  if (empty.size > 0 || untagged > 0 || kept > 0) {
    diagnostics.push({
      severity: empty.size > 0 || untagged > 0 ? 'warn' : 'info',
      message: `bakeGroups: ${kept} faces kept their group, ${untagged} faces match no part; parts with no new face: ${[...empty].join(', ') || 'none'}`,
      detail: { kept, untagged, empty: [...empty] },
    });
  }
  return ok(counts);
}

/** Golden-angle hue steps keep the colors of any number of groups apart; saturation and value are fixed. */
function groupColor(index: number): readonly [number, number, number] {
  const h = ((index * 137.50776405) % 360) / 60;
  const s = 0.75;
  const v = 0.95;
  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = v - c;
  const sector = Math.floor(h);
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector] as [number, number, number];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * Group ID map (Painter polygroup ID precedent): the UV layout of `channel` painted with one flat
 * color per bake group (`<prefix><id>` tag, groups in id order), transparent outside every island
 * and for ungrouped faces. The legend lists each group's color and face count. Deterministic.
 */
export function idMap(mesh: EditMesh, options: IdMapOptions = {}): Result<IdMap, ModelingError> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const channel = options.channel ?? 'uv0';
  const size = options.size ?? DEFAULT_SIZE;
  const bad = checkSize(size);
  if (bad !== undefined) return err(bad);
  const tags: { tag: number; id: string }[] = [];
  for (const [t, name] of mesh.tagNames.entries()) {
    if (prefix !== '' && name.startsWith(prefix))
      tags.push({ tag: t, id: name.slice(prefix.length) });
  }
  tags.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (tags.length === 0) {
    return err(
      modelingError(
        'model-precondition',
        `no face carries a ${prefix}<id> tag`,
        { prefix },
        'tag the parts with bakeGroups first',
      ),
    );
  }
  const faceGroup = new Map<number, number>();
  const faces = new Array<number>(tags.length).fill(0);
  for (const f of mesh.faces()) {
    const g = tags.findIndex((t) => mesh.hasTag(f, t.tag));
    if (g < 0) continue;
    faceGroup.set(f, g);
    faces[g] = (faces[g] as number) + 1;
  }
  const owners = faceOwners(mesh, channel, size);
  if (!owners.ok) return owners;
  const colors = tags.map((_, g) => groupColor(g));
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < owners.value.length; k++) {
    const g = faceGroup.get(owners.value[k] as number);
    if (g === undefined) continue;
    const c = colors[g] as readonly [number, number, number];
    data.set([c[0], c[1], c[2], 255], k * 4);
  }
  return ok({
    texture: texture(size, data),
    groups: tags.map((t, g) => ({
      id: t.id,
      color: colors[g] as readonly [number, number, number],
      faces: faces[g] as number,
    })),
  });
}
