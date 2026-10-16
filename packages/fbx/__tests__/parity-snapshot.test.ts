// parity-snapshot.test.ts — the four-class parity regression net (AC-08~12).
//
// After T5's double-run against the in-repo FBX SDK proved ufbx matches the SDK
// baseline field-for-field (within epsilon), the ufbx output was frozen as a
// compact structural digest under __tests__/__snapshots__/. This test recomputes the
// digest from live ufbx output and compares it to the frozen JSON — the
// long-term regression baseline once the SDK is deleted (M2).
//
// The digest deliberately captures the parity-critical structure (counts,
// material, geometry bbox, node roster, clip channel breakdown, sampled key
// values) rather than the full ~13 MB raw dump, keeping the fixture git-friendly
// (AC-12: text JSON, git-tracked) while staying falsifiable: any regression in
// the four M0 classes trips it.
//
// Coverage (requirements S4(a)-(d)):
//   (a) material identification — humanoid material real Phong, source diffuse
//       (not fallback grey) (AC-08).
//   (b) axis conversion — sample geometry Y-up, SDK-baseline bbox (AC-09).
//   (c) system-node filter — 85 nodes (Producer cameras / Camera Switcher
//       excluded) + source-evaluated run-clip channels (AC-10).
//   (d) empty-take filter — cube emits zero clips (AC-11).
//
// Freeze / re-freeze (ufbx-only, post-SDK-deletion): `pnpm -F @forgeax/engine-fbx
// build && node scripts/parity-diff.mjs --freeze`. Re-freezing changes the
// human-signed baseline — run it only with a deliberate parity re-sign.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initFbxWasm, parseFbxToObject } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, '../../../forgeax-engine-assets/vendor/fbx-test');
const SNAP_DIR = join(HERE, '__snapshots__');

interface RawMesh {
  readonly name?: string;
  readonly vertices: number[];
  readonly indices?: number[];
  readonly attributes?: Record<string, number[]>;
}
interface RawChannel {
  readonly targetNode: string;
  readonly property: string;
  readonly keyTimes: number[];
  readonly keyValues: number[];
}
interface RawClip {
  readonly name?: string;
  readonly duration: number;
  readonly channels: readonly RawChannel[];
}
interface RawNode {
  readonly name: string;
  readonly children?: readonly number[];
}
interface RawMaterial {
  readonly name?: string;
  readonly kind: string;
  readonly diffuse?: number[];
  readonly shininess?: number;
  readonly stingrayProps?: unknown;
}
interface RawSkeleton {
  readonly jointCount: number;
  readonly jointPaths: string[];
}
interface RawSkin {
  readonly meshSourceIndex: number;
  readonly vertexCount: number;
  readonly jointPaths: string[];
}
interface RawDoc {
  readonly meshes?: readonly RawMesh[];
  readonly nodes?: readonly RawNode[];
  readonly materials?: readonly RawMaterial[];
  readonly clips?: readonly RawClip[];
  readonly skeletons?: readonly RawSkeleton[];
  readonly skins?: readonly RawSkin[];
}

// MUST match scripts/parity-diff.mjs digest() so the freeze and the assertion
// compute the same shape. Keep the two in sync when either changes.
function bboxOf(vertices: readonly number[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = vertices[i + k] as number;
      if (v < (min[k] as number)) min[k] = v;
      if (v > (max[k] as number)) max[k] = v;
    }
  }
  return { min: min.map((x) => +x.toFixed(4)), max: max.map((x) => +x.toFixed(4)) };
}
function digest(raw: RawDoc): unknown {
  const meshes = (raw.meshes ?? []).map((m) => ({
    name: m.name,
    vertexFloats: m.vertices.length,
    indexCount: (m.indices ?? []).length,
    bbox: bboxOf(m.vertices),
    attributes: Object.keys(m.attributes ?? {}).sort(),
  }));
  const nodes = (raw.nodes ?? []).map((n) => n.name);
  const materials = (raw.materials ?? []).map((m) => ({
    name: m.name,
    kind: m.kind,
    ...(m.diffuse && { diffuse: m.diffuse.map((x) => +x.toFixed(6)) }),
    ...(m.shininess !== undefined && { shininess: +m.shininess.toFixed(4) }),
    ...(m.stingrayProps && { stingrayProps: m.stingrayProps }),
  }));
  const clips = (raw.clips ?? []).map((c) => ({
    name: c.name,
    duration: +c.duration.toFixed(6),
    channelCount: c.channels.length,
    channelsByProperty: {
      translation: c.channels.filter((ch) => ch.property === 'translation').length,
      rotation: c.channels.filter((ch) => ch.property === 'rotation').length,
      scale: c.channels.filter((ch) => ch.property === 'scale').length,
    },
    firstChannel: c.channels[0] && {
      targetNode: c.channels[0].targetNode,
      property: c.channels[0].property,
      keyCount: c.channels[0].keyTimes.length,
      firstKeyValues: c.channels[0].keyValues.slice(0, 4).map((x) => +x.toFixed(4)),
    },
  }));
  const skeletons = (raw.skeletons ?? []).map((s) => ({
    jointCount: s.jointCount,
    jointPaths: s.jointPaths,
  }));
  const skins = (raw.skins ?? []).map((s) => ({
    meshSourceIndex: s.meshSourceIndex,
    vertexCount: s.vertexCount,
    jointPathCount: s.jointPaths.length,
  }));
  return { meshes, nodes, materials, clips, skeletons, skins };
}

function liveDigest(name: string): unknown {
  const bytes = new Uint8Array(readFileSync(join(VENDOR, `${name}.fbx`)));
  return digest(parseFbxToObject(bytes) as RawDoc);
}
function liveDoc(name: string): RawDoc {
  const bytes = new Uint8Array(readFileSync(join(VENDOR, `${name}.fbx`)));
  return parseFbxToObject(bytes) as RawDoc;
}
function frozen(name: string): unknown {
  return JSON.parse(readFileSync(join(SNAP_DIR, `${name}-snapshot.json`), 'utf8'));
}

beforeAll(async () => {
  await initFbxWasm();
});

describe('parity — frozen snapshot regression net (AC-08~12)', () => {
  it('cube matches its frozen structural snapshot', () => {
    expect(liveDigest('cube')).toEqual(frozen('cube'));
  });

  // humanoid.fbx carries ~9s of animation; parsing it through the ufbx WASM at
  // assert time can exceed the 5s default under full-repo parallel test load
  // (observed 8.3s in `pnpm test:unit`; ~1s standalone). Generous timeout keeps
  // the regression net robust under concurrency without masking real drift.
  it('humanoid matches its frozen structural snapshot', () => {
    expect(liveDigest('humanoid')).toEqual(frozen('humanoid'));
  }, 30_000);
});

// Explicit per-class assertions on the frozen baseline. These document the four
// M0 parity fixes as human-readable expectations independent of the snapshot
// blob, so a future re-freeze that silently drifts still trips a named check.
describe('parity — four-class invariants on the frozen snapshot', () => {
  interface Digest {
    meshes: { bbox: { min: number[]; max: number[] } }[];
    nodes: string[];
    materials: { kind: string; diffuse?: number[] }[];
    clips: {
      name?: string;
      channelCount: number;
      channelsByProperty: { translation: number; rotation: number; scale: number };
    }[];
  }

  it('(AC-08) humanoid material is real Phong with source diffuse, not fallback', () => {
    const d = frozen('humanoid') as Digest;
    expect(d.materials).toHaveLength(1);
    const m = d.materials[0] as { kind: string; diffuse?: number[] };
    expect(m.kind).toBe('phong');
    expect(m.kind).not.toBe('fallback');
    expect(m.diffuse?.[0]).toBeCloseTo(0.588235, 4);
  });

  it('(AC-09) sample geometry is Y-up with SDK-baseline bbox', () => {
    const cube = frozen('cube') as Digest;
    expect(cube.meshes[0]?.bbox.min).toEqual([-5, -5, 0]);
    expect(cube.meshes[0]?.bbox.max).toEqual([5, 5, 10]);
    const humanoid = frozen('humanoid') as Digest;
    const hb = humanoid.meshes[0]?.bbox as { min: number[]; max: number[] };
    expect(hb.max[1] as number).toBeGreaterThan(hb.max[2] as number); // Y-up: vertical dominates depth
  });

  it('(AC-10) humanoid excludes system cameras/switcher (85 nodes) + 93 authored and derived run channels', () => {
    const d = frozen('humanoid') as Digest;
    expect(d.nodes).toHaveLength(85);
    expect(d.nodes).toContain('Camera');
    for (const n of d.nodes) {
      expect(n.startsWith('Producer ')).toBe(false);
      expect(n).not.toBe('Camera Switcher');
    }
    const run = d.clips.find((c) => c.name === 'run');
    expect(run?.channelCount).toBe(93);
    expect(run?.channelsByProperty).toEqual({ translation: 62, rotation: 31, scale: 0 });
  });

  it('humanoid animation targetNode values are unique full scene paths', () => {
    const raw = liveDoc('humanoid');
    const nodes = raw.nodes ?? [];
    const parents = new Map<number, number>();
    for (let index = 0; index < nodes.length; index++) {
      for (const child of nodes[index]?.children ?? []) parents.set(child, index);
    }
    const scenePaths = nodes.map((_, index) => {
      const names: string[] = [];
      let current: number | undefined = index;
      while (current !== undefined) {
        names.push(nodes[current]?.name ?? '');
        current = parents.get(current);
      }
      return names.reverse().join('/');
    });
    expect(new Set(scenePaths).size).toBe(scenePaths.length);
    for (const clip of raw.clips ?? []) {
      for (const channel of clip.channels) {
        expect(scenePaths).toContain(channel.targetNode);
      }
    }
  }, 30_000);

  it('(AC-11) cube emits no clips (its only take is empty)', () => {
    const d = frozen('cube') as Digest;
    expect(d.clips).toHaveLength(0);
  });
});
