import { describe, expect, it } from 'vitest';
import { type BakeOptions, bakeMaps } from '../bake';
import { measureUv } from '../compute/uv-ts';
import { EDGE_SEAM, EditMesh, FACE_MIRRORED } from '../mesh';
import { mirrorPairs } from '../mirror-pairing';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

/**
 * BK54: `uv.plan({ mirror: 'mirrored' })` plans the original half of a mirrored model and copies its
 * seams; `uv.pack({ stack: 'mirrored' })` gives each mirrored copy its partner's texels. The pairing is
 * derived from positions, so a copy that was moved or edited reports `unpaired` and keeps its own texels.
 */

const infoOf = (report: OpReport, needle: string): Record<string, unknown> => {
  const found = report.diagnostics?.find(
    (d) => d.severity === 'info' && d.message.startsWith(needle),
  );
  if (report.status !== 'ok' || found === undefined) {
    throw new Error(`${report.op}: ${report.error?.message ?? `no ${needle}`}`);
  }
  return found.detail as Record<string, unknown>;
};
const packInfo = (r: OpReport) => infoOf(r, 'uv.pack placed');
const packMetrics = (r: OpReport) =>
  packInfo(r).metrics as Record<string, number> & {
    islands: number;
    mirrored: number;
    texelsPerMeter: number;
  };
const warns = (r: OpReport) =>
  (r.diagnostics ?? []).filter((d) => d.severity === 'warn').map((d) => d.message);

/** A hemisphere on x < 0 mirrored across x = 0 (weld on the plane). */
function halfBody(): Model {
  const m = model();
  m.sphere({ radius: 1, widthSegments: 24, heightSegments: 12 });
  m.delete(sel.inBox([0.001, -2, -2], [2, 2, 2], { by: 'centroid' }));
  m.mirror({ axis: 'x', weldDistance: 1e-6 });
  return m;
}

const copyFaces = (m: Model) => sel.mirrored().evaluate(m.editMesh);
const originalFaces = (m: Model) =>
  m.editMesh.faces().filter((f) => ((m.editMesh.fFlags[f] as number) & FACE_MIRRORED) === 0);

function planned(options: { mirror: 'unique' | 'mirrored' }): Model {
  const m = halfBody();
  const r = m.uv.plan({ ...options });
  if (r.status !== 'ok') throw new Error(r.error?.message);
  return m;
}

const PACK = { resolution: 512, padding: 4 } as const;

describe('uv.plan mirror: mirrored (BK54)', () => {
  it('plans the original half and copies its seams to the partners', () => {
    const m = planned({ mirror: 'mirrored' });
    const mesh = m.editMesh;
    const pairs = mirrorPairs(mesh, mesh.faces(), 1e-5);
    expect(pairs.partner.size).toBe(copyFaces(m).length);
    expect(pairs.unpaired).toEqual([]);
    const seam = (e: number) => ((mesh.eFlags[e] as number) & EDGE_SEAM) !== 0;
    let compared = 0;
    for (const f of copyFaces(m)) {
      for (const h of mesh.faceHalves(f)) {
        const other = mesh.hFace[h ^ 1] as number;
        if (((mesh.fFlags[other] as number) & FACE_MIRRORED) === 0) continue;
        const image = pairs.edgeImage(h);
        expect(image).toBeDefined();
        expect(seam(h >> 1)).toBe(seam(image as number));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(0);
    let plane = 0;
    for (const f of copyFaces(m)) {
      for (const h of mesh.faceHalves(f)) {
        const other = mesh.hFace[h ^ 1] as number;
        if (((mesh.fFlags[other] as number) & FACE_MIRRORED) !== 0) continue;
        expect(seam(h >> 1)).toBe(true);
        plane++;
      }
    }
    expect(plane).toBeGreaterThan(0);
  });

  it('cuts the mirror plane, so each half is its own island (not one island across the plane)', () => {
    const m = planned({ mirror: 'mirrored' });
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    const ids = (faces: readonly number[]) =>
      new Set(faces.map((f) => measured.value.faceIsland[f] as number));
    const left = ids(originalFaces(m));
    const right = ids(copyFaces(m));
    expect([...left].some((i) => right.has(i))).toBe(false);
    expect(right.size).toBe(left.size);
  });

  it('reports the pairing and rejects a bad mode', () => {
    const m = halfBody();
    const ok = m.uv.plan({ mirror: 'mirrored' });
    expect(infoOf(ok, 'uv.plan mirror').pairs).toBe(copyFaces(m).length);
    const bad = halfBody().uv.plan({ mirror: 'both' as never });
    expect(bad.status).toBe('failed');
    expect(bad.error?.code).toBe('model-invalid-argument');
  });

  it("'unique' (default) is today's planner: no mirror report, the halves may join", () => {
    const m = halfBody();
    const r = m.uv.plan({});
    expect((r.diagnostics ?? []).some((d) => d.message.startsWith('uv.plan mirror'))).toBe(false);
  });
});

describe("uv.pack stack: 'mirrored' (BK54)", () => {
  it('stacks every mirrored island on its partner with the same UVs and fewer texels (falsifier)', () => {
    const unique = planned({ mirror: 'mirrored' });
    const base = packMetrics(unique.uv.pack({ ...PACK }));
    const m = planned({ mirror: 'mirrored' });
    const r = m.uv.pack({ ...PACK, stack: 'mirrored' });
    const k = packMetrics(r);
    const info = packInfo(r);
    expect(k.islands).toBe(base.islands);
    expect(k.mirrored).toBe(k.islands / 2);
    expect(info.mirroredPairs).toBe(k.islands / 2);
    expect(info.pairs).toBe(k.islands / 2);
    expect(info.unpaired).toBe(0);
    expect(info.texelsSaved as number).toBeGreaterThan(0);
    // The leader half owns the whole atlas, so its texel density is higher than when both halves share it.
    expect(k.texelsPerMeter).toBeGreaterThan(base.texelsPerMeter);
    expect(warns(r)).toEqual([]);

    const mesh = m.editMesh;
    const pairs = mirrorPairs(mesh, mesh.faces(), 1e-5);
    for (const [copy, { face, axis }] of pairs.partner) {
      const twins = mesh.faceHalves(face);
      for (const h of mesh.faceHalves(copy)) {
        const image = pairs.image(axis, mesh.hVert[h] as number);
        const twin = twins.find((t) => mesh.hVert[t] === image) as number;
        expect(Array.from(mesh.corner('uv0', h) as Float32Array)).toEqual(
          Array.from(mesh.corner('uv0', twin) as Float32Array),
        );
      }
    }
  });

  it('seams of the original half appear on the copies: a box half with hard edges stacks whole', () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [2, 1, 1] } as never);
    m.delete(sel.inBox([0.001, -2, -2], [2, 2, 2], { by: 'centroid' }));
    m.mirror({ axis: 'x', weldDistance: 1e-6 });
    const plan = m.uv.plan({ mirror: 'mirrored' });
    expect(plan.status).toBe('ok');
    const mesh = m.editMesh;
    const pairs = mirrorPairs(mesh, mesh.faces(), 1e-5);
    let seamed = 0;
    for (const f of originalFaces(m)) {
      for (const h of mesh.faceHalves(f)) {
        const other = mesh.hFace[h ^ 1] as number;
        if (((mesh.fFlags[other] as number) & FACE_MIRRORED) !== 0) continue;
        if (((mesh.eFlags[h >> 1] as number) & EDGE_SEAM) === 0) continue;
        seamed++;
      }
    }
    expect(seamed).toBeGreaterThan(0);
    let copied = 0;
    for (const f of copyFaces(m)) {
      for (const h of mesh.faceHalves(f)) {
        const image = pairs.edgeImage(h);
        if (image === undefined) continue;
        if (((mesh.eFlags[image] as number) & EDGE_SEAM) !== 0) {
          expect((mesh.eFlags[h >> 1] as number) & EDGE_SEAM).toBe(EDGE_SEAM);
          copied++;
        }
      }
    }
    expect(copied).toBeGreaterThan(0);
    const r = m.uv.pack({ ...PACK, stack: 'mirrored' });
    expect(packMetrics(r).mirrored).toBe(packMetrics(r).islands / 2);
    expect(warns(r)).toEqual([]);
  });

  it('the copies are the mirror image: inverted triangles, no inverted-triangle warning', () => {
    const m = planned({ mirror: 'mirrored' });
    const r = m.uv.pack({ ...PACK, stack: 'mirrored' });
    expect(warns(r)).toEqual([]);
    const mesh = m.editMesh;
    let inverted = 0;
    for (const f of copyFaces(m)) {
      const [a, b, c] = mesh.faceHalves(f).map((h) => mesh.corner('uv0', h) as Float32Array) as [
        Float32Array,
        Float32Array,
        Float32Array,
      ];
      const turn =
        ((b[0] as number) - (a[0] as number)) * ((c[1] as number) - (a[1] as number)) -
        ((b[1] as number) - (a[1] as number)) * ((c[0] as number) - (a[0] as number));
      if (turn < 0) inverted++;
    }
    expect(inverted).toBeGreaterThan(copyFaces(m).length * 0.9);
  });

  it('a stacked follower is expected to be inverted: an inverted leader makes both halves count', () => {
    const m = planned({ mirror: 'mirrored' });
    const projected = m.uv.project({
      mode: 'planar',
      axis: 'x',
      scale: 1,
      faces: sel.mirrored().not(),
    });
    expect(projected.status).toBe('ok');
    const r = m.uv.pack({ ...PACK, stack: 'mirrored' });
    expect(packMetrics(r).mirrored).toBeGreaterThan(0);
    const flipped = (r.diagnostics ?? []).find((d) => d.message.includes('inverted UV triangles'));
    expect(flipped?.detail?.flipped).toBe(m.editMesh.faces().length);
  });

  it('stack: true stays translation / quarter-turn only: it never stacks a reflection (falsifier)', () => {
    const m = planned({ mirror: 'mirrored' });
    const r = m.uv.pack({ ...PACK, stack: true });
    const k = packMetrics(r);
    expect(k.mirrored).toBe(0);
    expect(packInfo(r).mirroredPairs).toBe(0);
  });

  it('a bad stack value is model-invalid-argument', () => {
    const m = planned({ mirror: 'mirrored' });
    const r = m.uv.pack({ ...PACK, stack: 'sideways' as never });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-invalid-argument');
  });

  it('without a mirror plan the halves are one island: nothing is stacked, nothing breaks', () => {
    const m = planned({ mirror: 'unique' });
    const r = m.uv.pack({ ...PACK, stack: 'mirrored' });
    expect(packMetrics(r).mirrored).toBe(0);
  });
});

describe('moved or edited copies fall back to unique (BK54)', () => {
  it('a copy moved after mirroring is unpaired, reported, and keeps its own texels without an error', () => {
    const m = halfBody();
    m.translate(sel.mirrored(), [0.3, 0, 0]);
    const plan = m.uv.plan({ mirror: 'mirrored' });
    expect(plan.status).toBe('ok');
    expect(infoOf(plan, 'uv.plan mirror').unpaired).toBe(copyFaces(m).length);
    expect(warns(plan).some((w) => w.includes('reflect no unmirrored face'))).toBe(true);
    const r = m.uv.pack({ ...PACK, stack: 'mirrored' });
    expect(r.status).toBe('ok');
    expect(packMetrics(r).mirrored).toBe(0);
    expect(packInfo(r).unpaired).toBe(copyFaces(m).length);
    expect(packInfo(r).texelsSaved).toBe(0);
  });

  it('an island with one unpaired face is not stacked at all (pack level)', () => {
    const m = halfBody();
    const mesh = m.editMesh;
    const bumped = copyFaces(m)[7] as number;
    for (const v of mesh.faceVertices(bumped)) {
      const p = mesh.position(v);
      if (Math.abs(p[0]) > 1e-6) mesh.setPosition(v, p[0] * 1.1, p[1], p[2]);
    }
    const plan = m.uv.plan({ mirror: 'mirrored' });
    expect(plan.status).toBe('ok');
    const r = m.uv.pack({ ...PACK, stack: 'mirrored' });
    expect(r.status).toBe('ok');
    expect(packMetrics(r).mirrored).toBe(0);
    expect(packInfo(r).unpaired as number).toBeGreaterThan(0);
  });

  it('a bump on a few copy faces: those faces are unpaired, the rest still pair', () => {
    const m = halfBody();
    const copies = copyFaces(m);
    const bumped = copies.filter((_, i) => i % 40 === 0);
    const mesh = m.editMesh;
    const moved = new Set(bumped.flatMap((f) => mesh.faceVertices(f)));
    for (const v of moved) {
      const p = mesh.position(v);
      if (Math.abs(p[0]) > 1e-6) mesh.setPosition(v, p[0] * 1.1, p[1], p[2]);
    }
    const pairs = mirrorPairs(mesh, mesh.faces(), 1e-5);
    expect(pairs.unpaired.length).toBeGreaterThanOrEqual(bumped.length);
    expect(pairs.partner.size + pairs.unpaired.length).toBe(copies.length);
    expect(pairs.partner.size).toBeGreaterThan(0);
  });
});

describe('partial pairing is reported for what it is (BK54, audit 3)', () => {
  function bumpedBody(): Model {
    const m = halfBody();
    const mesh = m.editMesh;
    const bumped = copyFaces(m)[7] as number;
    for (const v of mesh.faceVertices(bumped)) {
      const p = mesh.position(v);
      if (Math.abs(p[0]) > 1e-6) mesh.setPosition(v, p[0] * 1.1, p[1], p[2]);
    }
    return m;
  }

  it("names the unstacked reflected copy, not slivers: no 'inverted UV triangles' blame (falsifier)", () => {
    const m = bumpedBody();
    expect(m.uv.plan({ mirror: 'mirrored' }).status).toBe('ok');
    const r = m.uv.pack({ ...PACK, stack: 'mirrored' });
    expect(r.status).toBe('ok');
    const all = warns(r);
    expect(all.some((w) => w.includes('inverted UV triangles'))).toBe(false);
    const note = (r.diagnostics ?? []).find((d) => d.message.includes('carry the reflected UVs'));
    expect(note?.severity).toBe('warn');
    expect(note?.message).toContain('were not stacked on it');
    expect(note?.message).toContain('reflect no original face');
    const detail = note?.detail as {
      reflectedUnstacked: number;
      unpairedCopies: number;
      faces: number[];
    };
    expect(detail.unpairedCopies).toBeGreaterThan(0);
    expect(detail.reflectedUnstacked).toBeGreaterThan(0);
    expect(detail.faces.length).toBeGreaterThan(0);
    for (const f of detail.faces) {
      expect(((m.editMesh.fFlags[f] as number) & FACE_MIRRORED) !== 0).toBe(true);
    }
  });

  it("plan 'mirrored' then stack: true: the same reflected copy is named, with the stack hint", () => {
    const m = planned({ mirror: 'mirrored' });
    const r = m.uv.pack({ ...PACK, stack: true });
    const all = warns(r);
    expect(all.some((w) => w.includes('inverted UV triangles'))).toBe(false);
    const note = all.find((w) => w.includes('carry the reflected UVs'));
    expect(note).toContain("only with stack 'mirrored'");
  });
});

describe('stacking needs the same faces on both sides (BK54, audit 3)', () => {
  const planar = { mode: 'planar', axis: 'z', scale: 1 } as const;

  const boxBody = () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [2, 1, 1] } as never);
    m.delete(sel.inBox([0.001, -2, -2], [2, 2, 2], { by: 'centroid' }));
    m.mirror({ axis: 'x', weldDistance: 1e-6 });
    expect(m.uv.plan({ mirror: 'mirrored' }).status).toBe('ok');
    return m;
  };

  it('a follower island smaller than its partner island is not stacked (source-faces guard)', () => {
    const m = boxBody();
    expect(packMetrics(boxBody().uv.pack({ ...PACK, stack: 'mirrored' })).mirrored).toBe(5);
    const originals = originalFaces(m);
    const big = m.uv.project({ ...planar, faces: sel.mirrored().not() });
    expect(big.status).toBe('ok');
    expect(originals.length).toBeGreaterThan(2);
    const r = m.uv.pack({ ...PACK, stack: 'mirrored' });
    expect(r.status).toBe('ok');
    expect(packMetrics(r).mirrored).toBe(0);
  });

  it('a follower island larger than its partner islands is not stacked (single-leader guard)', () => {
    const m = boxBody();
    const big = m.uv.project({ ...planar, faces: sel.mirrored() });
    expect(big.status).toBe('ok');
    const r = m.uv.pack({ ...PACK, stack: 'mirrored' });
    expect(r.status).toBe('ok');
    expect(packMetrics(r).mirrored).toBe(0);
  });
});

describe('pairing edge cases (BK54, audit 3)', () => {
  const quad = (mesh: EditMesh, xs: readonly number[], reversed: boolean, flagged: boolean) => {
    const [x0, x1] = xs as [number, number];
    const loop = [
      mesh.addVertex(x0, 0, 0),
      mesh.addVertex(x1, 0, 0),
      mesh.addVertex(x1, 1, 0),
      mesh.addVertex(x0, 1, 0),
    ];
    const f = mesh.addFace(reversed ? loop.reverse() : loop);
    if (!f.ok) throw f.error;
    if (flagged) mesh.fFlags[f.value] = (mesh.fFlags[f.value] as number) | FACE_MIRRORED;
    return f.value;
  };
  const pairedWith = (offset: number, tolerance: number) => {
    const mesh = new EditMesh();
    quad(mesh, [1, 2], false, false);
    const copy = quad(mesh, [-1 - offset, -2 - offset], true, true);
    return mirrorPairs(mesh, mesh.faces(), tolerance).partner.has(copy);
  };

  it('pairs a vertex exactly one tolerance away, not one beyond (boundary and magnitude)', () => {
    expect(pairedWith(0, 0.25)).toBe(true);
    expect(pairedWith(0.25, 0.25)).toBe(true);
    expect(pairedWith(0.3, 0.25)).toBe(false);
    expect(pairedWith(0.5, 0.25)).toBe(false);
  });

  it('finds the image in a neighbouring grid cell', () => {
    expect(pairedWith(-0.1, 0.25)).toBe(true);
    expect(pairedWith(0.1, 0.25)).toBe(true);
  });

  it('a copy face whose image is a triangle of a quad is not paired with the quad', () => {
    const mesh = new EditMesh();
    const original = quad(mesh, [1, 2], false, false);
    const [a, b, c] = mesh.faceVertices(original).slice(0, 3) as [number, number, number];
    const mirror = (v: number) => {
      const p = mesh.position(v);
      return mesh.addVertex(-p[0], p[1], p[2]);
    };
    const tri = mesh.addFace([mirror(c), mirror(b), mirror(a)]);
    if (!tri.ok) throw tri.error;
    mesh.fFlags[tri.value] = (mesh.fFlags[tri.value] as number) | FACE_MIRRORED;
    expect(mirrorPairs(mesh, mesh.faces(), 1e-5).partner.has(tri.value)).toBe(false);
  });

  it('a flagged face is never a partner, even when it reuses the original vertices', () => {
    const mesh = new EditMesh();
    const [a, b, c] = [
      mesh.addVertex(1, 0, 0),
      mesh.addVertex(2, 0, 0),
      mesh.addVertex(1, 1, 0),
    ] as [number, number, number];
    const o = mesh.addFace([a, b, c]);
    const back = mesh.addFace([c, b, a]);
    if (!o.ok || !back.ok) throw new Error('faces');
    mesh.fFlags[back.value] = (mesh.fFlags[back.value] as number) | FACE_MIRRORED;
    const mirror = (v: number) => {
      const p = mesh.position(v);
      return mesh.addVertex(-p[0], p[1], p[2]);
    };
    const copy = mesh.addFace([mirror(a), mirror(b), mirror(c)]);
    if (!copy.ok) throw copy.error;
    mesh.fFlags[copy.value] = (mesh.fFlags[copy.value] as number) | FACE_MIRRORED;
    const pairs = mirrorPairs(mesh, mesh.faces(), 1e-5);
    for (const { face } of pairs.partner.values()) expect(face).toBe(o.value);
  });

  it('a tag that differs between partners is asymmetric, and the pack names it', () => {
    const m = planned({ mirror: 'mirrored' });
    const mesh = m.editMesh;
    const [first] = [...mirrorPairs(mesh, mesh.faces(), 1e-5).partner.keys()] as [number];
    mesh.addTag(first, 3);
    expect(mirrorPairs(mesh, mesh.faces(), 1e-5).asymmetric).toEqual([first]);
    const w = (m.uv.pack({ ...PACK, stack: 'mirrored' }).diagnostics ?? []).find(
      (d) => d.severity === 'warn',
    );
    expect(w?.message).toContain('another material or tag set');
  });

  it("the pack pairs with the model's tolerance, not the default", () => {
    const m = model({ tolerance: 1e-3 });
    m.sphere({ radius: 1, widthSegments: 24, heightSegments: 12 });
    m.delete(sel.inBox([0.001, -2, -2], [2, 2, 2], { by: 'centroid' }));
    m.mirror({ axis: 'x', weldDistance: 1e-6 });
    const mesh = m.editMesh;
    const moved = new Set(copyFaces(m).flatMap((f) => mesh.faceVertices(f)));
    for (const v of moved) {
      const p = mesh.position(v);
      if (Math.abs(p[0]) > 1e-6) mesh.setPosition(v, p[0] + 3e-4, p[1], p[2]);
    }
    expect(m.uv.plan({ mirror: 'mirrored' }).status).toBe('ok');
    const r = m.uv.pack({ ...PACK, stack: 'mirrored' });
    expect(packMetrics(r).mirrored).toBeGreaterThan(0);
  });
});

describe('asymmetric pairs (BK54)', () => {
  it('a material slot that differs between partners is warned about by name', () => {
    const m = planned({ mirror: 'mirrored' });
    const mesh = m.editMesh;
    const pairs = mirrorPairs(mesh, mesh.faces(), 1e-5);
    const [first] = [...pairs.partner.keys()];
    mesh.fMaterial[first as number] = (mesh.fMaterial[first as number] as number) + 1;
    const odd = mirrorPairs(mesh, mesh.faces(), 1e-5).asymmetric;
    expect(odd).toEqual([first]);
    const r = m.uv.pack({ ...PACK, stack: 'mirrored' });
    const w = (r.diagnostics ?? []).find((d) => d.severity === 'warn');
    expect(w?.message).toContain('another material or tag set');
    expect((w?.detail?.faces as { face: number }[])[0]?.face).toBe(first);
  });
});

describe('stack-conflict cross-check (BK54, V5)', () => {
  const P = 0.1;
  const RES = 64;
  const TILT = 20;

  function plates(): Model {
    const m = model();
    m.plane({ width: P, height: P, widthSegments: 4, heightSegments: 4 });
    m.translate(sel.all(), [-P / 2, 0, 0]);
    m.mirror({ axis: 'x', weldDistance: 1e-6 });
    const plan = m.uv.plan({ mirror: 'mirrored' });
    expect(plan.status).toBe('ok');
    const pack = m.uv.pack({ resolution: 128, padding: 2, stack: 'mirrored' });
    expect(packMetrics(pack).mirrored).toBeGreaterThan(0);
    return m;
  }

  function detail(first: number, second: number): Model {
    const m = model();
    for (const [cx, angle] of [
      [-P / 2, first],
      [P / 2, second],
    ] as const) {
      const plane = model();
      plane.plane({ width: 0.95 * P, height: 0.95 * P, widthSegments: 2, heightSegments: 2 });
      if (angle !== 0) plane.rotate(sel.all(), 'y', angle);
      plane.translate(sel.all(), [cx, 0, 0.005]);
      m.append(plane);
    }
    return m;
  }

  const options = (d: Model): BakeOptions => ({
    base: plates(),
    detail: d,
    maps: ['normal'],
    resolution: RES,
    cage: { offset: 0.03, maxRay: 0.06 },
    gutter: 'fill',
  });
  const run = (d: Model) => {
    const r = bakeMaps(options(d));
    if (!r.ok) throw r.error;
    return r.value;
  };

  it('a symmetric detail on the stacked halves bakes clean; an asymmetric one conflicts', () => {
    const symmetric = run(detail(TILT, -TILT));
    expect(symmetric.provenance.stack.samples).toBeGreaterThan(0);
    expect(symmetric.issues.map((i) => i.code)).not.toContain('stack-conflict');
    const asymmetric = run(detail(TILT, TILT));
    expect(asymmetric.issues.map((i) => i.code)).toContain('stack-conflict');
  });
});
