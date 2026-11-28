import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type BakeOptions, bakeMaps } from '../bake';
import { type Model, model } from '../model';
import { type BakeGroupsOptions, idMap } from '../part-groups';
import { sel } from '../selectors';

/**
 * BK48: the part tags map to `bake:<id>` groups and an ID map paints them. The truth is the
 * hand-tagged bake (what `buildTurretAsset` did per part); the wrong-map mutant swaps two parts
 * and must be told apart by both the bytes and the ID map.
 */

const RES = 128;
const MAP: BakeGroupsOptions = { parts: ['a', 'b'] };
const SWAPPED: BakeGroupsOptions = {
  parts: [
    { tag: 'a', group: 'b' },
    { tag: 'b', group: 'a' },
  ],
};

function parts(tagOf: (part: 'a' | 'b') => string): { low: Model; high: Model } {
  const low = model();
  low.box({ size: [0.0975, 0.02, 0.1], center: [-0.05125, 0, 0], tag: tagOf('a') });
  low.box({ size: [0.0975, 0.04, 0.1], center: [0.05125, 0.01, 0], tag: tagOf('b') });
  low.markSharp(sel.edges.dihedral('>', 40));
  low.uv.auto({ resolution: RES, padding: 4 });
  const high = model();
  high.box({ size: [0.0975, 0.02, 0.1], center: [-0.05125, 0, 0], tag: tagOf('a') });
  high.box({ size: [0.01, 0.008, 0.01], center: [-0.08, 0.014, 0], tag: tagOf('a') });
  high.box({ size: [0.0975, 0.04, 0.1], center: [0.05125, 0.01, 0], tag: tagOf('b') });
  return { low, high };
}

function bake(low: Model, high: Model, extra: Partial<BakeOptions> = {}) {
  const r = bakeMaps({
    base: low,
    detail: high,
    maps: ['height', 'materialId'],
    resolution: RES,
    filter: 'none',
    tags: { groupPrefix: 'bake:' },
    ...extra,
  });
  if (!r.ok) throw r.error;
  return r.value;
}

const bytes = (t: TextureAsset | undefined) => Buffer.from((t as TextureAsset).data as Uint8Array);

describe('Model.bakeGroups', () => {
  it('derives the hand-tagged bake groups from part tags (truth: hand tags)', {
    timeout: 60000,
  }, () => {
    const hand = parts((p) => `bake:${p}`);
    const auto = parts((p) => p);
    for (const m of [auto.low, auto.high]) expect(m.bakeGroups(MAP).status).toBe('ok');
    const want = bake(hand.low, hand.high);
    const got = bake(auto.low, auto.high);
    expect(got.provenance.groups.map((g) => g.id)).toEqual(['a', 'b']);
    expect(bytes(got.textures.height).equals(bytes(want.textures.height))).toBe(true);
    expect(bytes(got.textures.materialId).equals(bytes(want.textures.materialId))).toBe(true);
  });

  it('falsifier: a wrong part map changes the bake (swapped groups on the low read the other detail)', {
    timeout: 60000,
  }, () => {
    const hand = parts((p) => `bake:${p}`);
    const auto = parts((p) => p);
    expect(auto.low.bakeGroups(SWAPPED).status).toBe('ok');
    expect(auto.high.bakeGroups(MAP).status).toBe('ok');
    const cage = { cage: { offset: 0.01, maxRay: 0.04 } };
    const want = bake(hand.low, hand.high, cage);
    const wrong = bake(auto.low, auto.high, cage);
    expect(bytes(wrong.textures.height).equals(bytes(want.textures.height))).toBe(false);
    const hits = (r: ReturnType<typeof bake>) =>
      Math.min(...r.provenance.groups.map((g) => g.rayHits / g.samples));
    expect(hits(want)).toBeGreaterThan(0.9);
    expect(hits(wrong)).toBeLessThan(hits(want));
  });

  it('takes the first matching part, carves a sub-group with where, and renames with group', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'house' });
    m.box({ size: [1, 1, 1], center: [3, 0, 0], tag: 'pin' });
    const r = m.bakeGroups({
      parts: [
        { tag: 'house', group: 'trim', where: sel.inBox([-1, 0.4, -1], [1, 1, 1]) },
        'house',
        { tag: 'pin', group: 'house' },
      ],
    });
    expect(r.status).toBe('ok');
    const trim = m.editMesh.tagIndex('bake:trim', false);
    const house = m.editMesh.tagIndex('bake:house', false);
    const faces = [...m.editMesh.faces()];
    const count = (t: number) => faces.filter((f) => m.editMesh.hasTag(f, t)).length;
    expect(count(trim) + count(house)).toBe(faces.length);
    expect(count(trim)).toBeGreaterThan(0);
    expect(count(house)).toBeGreaterThan(6);
  });

  it('keeps explicit group tags, skips tool faces, reports unmatched parts and bad input', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'a' });
    m.box({ size: [1, 1, 1], center: [3, 0, 0], tag: 'b' });
    m.tag(sel.tag('a'), 'bake:custom');
    m.markRole(sel.tag('b'), 'tool');
    const r = m.bakeGroups({ parts: ['a', 'b', 'missing'] });
    expect(r.status).toBe('ok');
    expect(m.editMesh.tagIndex('bake:a', false)).toBe(-1);
    expect(m.editMesh.tagIndex('bake:b', false)).toBe(-1);
    const warn = r.diagnostics?.find((d) => d.message.startsWith('bakeGroups'));
    expect(warn?.detail).toMatchObject({ empty: ['a', 'b', 'missing'] });
    const again = m.bakeGroups({ parts: ['a'], roles: ['form', 'detail', 'tool'] });
    expect(again.status).toBe('ok');
    const none = model();
    none.box({ size: [1, 1, 1], tag: 'a' });
    expect(none.bakeGroups({ parts: [] }).status).toBe('failed');
    const bare = model();
    bare.box({ size: [1, 1, 1], tag: 'a' });
    expect(bare.bakeGroups({ parts: ['a'], prefix: '' }).status).toBe('failed');
  });
});

describe('idMap', () => {
  const groupAt = (m: ReturnType<typeof idMap>, x: number, y: number, size: number) => {
    if (!m.ok) throw m.error;
    const d = m.value.texture.data as Uint8Array;
    const o = (y * size + x) * 4;
    if (d[o + 3] === 0) return undefined;
    return m.value.groups.find(
      (g) => g.color[0] === d[o] && g.color[1] === d[o + 1] && g.color[2] === d[o + 2],
    )?.id;
  };

  function layout(map: BakeGroupsOptions) {
    const { low } = parts((p) => p);
    low.bakeGroups(map);
    return low;
  }

  it('paints each island with its group color; truth: the group of the part the island belongs to', () => {
    const low = layout(MAP);
    const out = idMap(low.editMesh, { size: RES });
    if (!out.ok) throw out.error;
    expect(out.value.groups.map((g) => g.id)).toEqual(['a', 'b']);
    expect(new Set(out.value.groups.map((g) => g.color.join(','))).size).toBe(2);
    expect(out.value.groups.reduce((n, g) => n + g.faces, 0)).toBe(
      [...low.editMesh.faces()].length,
    );
    const mesh = low.editMesh;
    const a = mesh.tagIndex('a', false);
    let checked = 0;
    for (const f of mesh.faces()) {
      const uv = mesh.faceHalves(f).map((h) => mesh.corner('uv0', h) as Float32Array);
      const cu = uv.reduce((s, c) => s + (c[0] as number), 0) / uv.length;
      const cv = uv.reduce((s, c) => s + (c[1] as number), 0) / uv.length;
      const got = groupAt(out, Math.floor(cu * RES), Math.floor(cv * RES), RES);
      expect(got).toBe(mesh.hasTag(f, a) ? 'a' : 'b');
      checked++;
    }
    expect(checked).toBe(12);
  });

  it('falsifier: the swapped map paints the islands with the other color', () => {
    const truth = idMap(layout(MAP).editMesh, { size: RES });
    const wrong = idMap(layout(SWAPPED).editMesh, { size: RES });
    if (!truth.ok || !wrong.ok) throw new Error('idMap failed');
    expect(bytes(wrong.value.texture).equals(bytes(truth.value.texture))).toBe(false);
  });

  it('is deterministic and rejects a mesh without groups or a bad size', () => {
    const low = layout(MAP);
    const a = idMap(low.editMesh, { size: 64 });
    const b = idMap(low.editMesh, { size: 64 });
    if (!a.ok || !b.ok) throw new Error('idMap failed');
    expect(bytes(a.value.texture).equals(bytes(b.value.texture))).toBe(true);
    expect(idMap(low.editMesh, { size: 0 }).ok).toBe(false);
    expect(idMap(parts((p) => p).low.editMesh).ok).toBe(false);
  });

  it('falsifier: a mesh without uv0 or with an unset corner is a precondition Result, never a throw', () => {
    const bare = model();
    bare.box({ size: [1, 1, 1], tag: 'a' });
    bare.bakeGroups({ parts: ['a'] });
    for (const size of [1, 64, 4096, 4097]) {
      const r = idMap(bare.editMesh, { size });
      expect(r.ok).toBe(false);
    }
    const r = idMap(bare.editMesh, { size: 64 });
    if (r.ok) throw new Error('expected a failure');
    expect(r.error.code).toBe('model-precondition');
    expect(r.error.detail).toMatchObject({ code: 'no-uv', channel: 'uv0' });

    const low = layout(MAP);
    const mesh = low.editMesh;
    const f = mesh.faces()[3] as number;
    const h = mesh.faceHalves(f)[0] as number;
    const channel = mesh.channels.get('uv0');
    (channel?.set as Uint8Array)[h] = 0;
    const partial = idMap(mesh, { size: RES });
    if (partial.ok) throw new Error('expected a failure');
    expect(partial.error.detail).toMatchObject({ code: 'no-uv', face: f });
    expect(idMap(mesh, { size: RES, channel: 'uv1' }).ok).toBe(false);
  });

  it('falsifier: ungrouped faces stay transparent instead of taking the first group color', () => {
    const { low } = parts((p) => p);
    low.bakeGroups({ parts: ['a'] });
    const out = idMap(low.editMesh, { size: RES });
    if (!out.ok) throw out.error;
    expect(out.value.groups.map((g) => [g.id, g.faces])).toEqual([['a', 6]]);
    const mesh = low.editMesh;
    const a = mesh.tagIndex('a', false);
    const d = out.value.texture.data as Uint8Array;
    let painted = 0;
    let clear = 0;
    for (const f of mesh.faces()) {
      const uv = mesh.faceHalves(f).map((h) => mesh.corner('uv0', h) as Float32Array);
      const cu = uv.reduce((s, c) => s + (c[0] as number), 0) / uv.length;
      const cv = uv.reduce((s, c) => s + (c[1] as number), 0) / uv.length;
      const alpha = d[(Math.floor(cv * RES) * RES + Math.floor(cu * RES)) * 4 + 3];
      if (mesh.hasTag(f, a)) {
        expect(alpha).toBe(255);
        painted++;
      } else {
        expect(alpha).toBe(0);
        clear++;
      }
    }
    expect([painted, clear]).toEqual([6, 6]);
  });
});
