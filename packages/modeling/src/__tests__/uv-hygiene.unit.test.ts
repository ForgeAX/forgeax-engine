import { describe, expect, it } from 'vitest';
import { measureUv } from '../compute/uv-ts';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';
import { uvOverlapPairs } from '../uv-overlap';
import { uvCheckerTexture, uvHeatmapTexture } from '../uv-textures';

function info(report: OpReport): Record<string, number> {
  const last = report.diagnostics?.filter((d) => d.severity === 'info').at(-1);
  if (report.status !== 'ok' || last === undefined) {
    throw new Error(`${report.op}: ${report.error?.message}`);
  }
  return last.detail as Record<string, number>;
}

/** A sphere with one latitude band tagged: its island is thin and touches two neighbors. */
function bandedSphere(): Model {
  const rows = 12;
  const m = model();
  m.sphere({ radius: 1, widthSegments: 24, heightSegments: rows });
  const top = Math.cos((4 * Math.PI) / rows) + 0.01;
  const bottom = Math.cos((5 * Math.PI) / rows) - 0.01;
  m.tag(sel.inBox([-2, bottom, -2], [2, top, 2]), 'band');
  return m;
}

/** Planar projection of an open tube: the front and back halves land on the same UV area. */
function foldedTube(): Model {
  const m = model();
  m.cylinder({
    radiusTop: 0.5,
    radiusBottom: 0.5,
    height: 1,
    radialSegments: 16,
    heightSegments: 2,
    openEnded: true,
  });
  m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
  return m;
}

function bytes(m: Model): string {
  const mesh = m.editMesh;
  let out = '';
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) out += `${Array.from(mesh.corner('uv0', h) ?? [])};`;
  }
  return out;
}

describe('uv.plan island merge fallback', () => {
  it('a thin island whose longest border exceeds maxStretch merges into its other neighbor', () => {
    const m = bandedSphere();
    const facts = info(m.uv.plan({ maxStretch: 1.8, hardAngle: 180, minWidth: 0.4 }));
    expect(facts.merged).toBe(1);
    expect(facts.islands).toBe(2);
    expect(facts.thin).toBe(0);
    expect(facts.unresolved).toBe(0);
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    expect(measured.value.flipped).toBe(0);
    expect(measured.value.zeroArea).toBe(0);
    for (const island of measured.value.islands)
      expect(island.stretchLinf).toBeLessThanOrEqual(1.8);
  });
});

describe('uv.plan thin count', () => {
  it('counts an island that stays narrower than minWidth, and only then', () => {
    // With a tight stretch bound the band cannot merge into a wall, so one thin island remains.
    const kept = info(bandedSphere().uv.plan({ maxStretch: 1.1, hardAngle: 180, minWidth: 0.4 }));
    expect(kept.thin).toBe(1);
    expect(kept.islands).toBe(6);
    const none = info(bandedSphere().uv.plan({ maxStretch: 1.1, hardAngle: 180, minWidth: 0.01 }));
    expect(none.thin).toBe(0);
  });
});

describe('uv.pack resolveOverlaps', () => {
  it('leaves overlaps by default and removes them when asked (falsifier: 0 passes)', () => {
    const left = foldedTube();
    const off = info(left.uv.pack({ resolution: 256, padding: 4, method: 'raster' }));
    expect(off.overlaps).toBeUndefined();
    expect(uvOverlapPairs(left.editMesh, left.editMesh.faces()).length).toBeGreaterThan(0);

    const fixed = foldedTube();
    const facts = info(
      fixed.uv.pack({ resolution: 256, padding: 4, method: 'raster', resolveOverlaps: 3 }),
    );
    expect(facts.overlaps).toBe(0);
    expect(facts.overlapPasses).toBeGreaterThanOrEqual(1);
    expect(uvOverlapPairs(fixed.editMesh, fixed.editMesh.faces())).toEqual([]);
    expect(fixed.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain(
      'uv-overlap',
    );
    const measured = measureUv(fixed.editMesh);
    if (!measured.ok) throw measured.error;
    expect(measured.value.flipped).toBe(0);
  });

  it('is byte-deterministic', () => {
    const a = foldedTube();
    const b = foldedTube();
    a.uv.pack({ resolution: 256, padding: 4, method: 'raster', resolveOverlaps: 3 });
    b.uv.pack({ resolution: 256, padding: 4, method: 'raster', resolveOverlaps: 3 });
    expect(bytes(a)).toBe(bytes(b));
  });

  it('rejects a pass count outside 0..8', () => {
    for (const bad of [-1, 9, 1.5, Number.NaN]) {
      const report = foldedTube().uv.pack({ resolution: 256, padding: 4, resolveOverlaps: bad });
      expect(report.status).toBe('failed');
      expect(report.error?.code).toBe('model-invalid-argument');
    }
  });

  it('uvOverlapPairs finds exactly the pairs validate reports', () => {
    const m = foldedTube();
    m.uv.pack({ resolution: 256, padding: 4, method: 'raster' });
    const pairs = uvOverlapPairs(m.editMesh, m.editMesh.faces());
    const issue = m.validate({ uniqueUv: true }).issues.find((i) => i.code === 'uv-overlap');
    const detail = issue?.detail as { pairs: number; faces: [number, number][] };
    expect(detail.pairs).toBe(pairs.length);
    expect(detail.faces).toEqual(pairs.slice(0, detail.faces.length));
  });
});

describe('uvMeasure per-face facts', () => {
  it('faceDensity ratios follow the island scale; faceStretch is at least 1', () => {
    const m = model();
    m.plane({ width: 2, height: 1, widthSegments: 2, heightSegments: 1 });
    m.tag(sel.inBox([-2, -1, -1], [0, 1, 1]), 'a');
    m.tag(sel.inBox([0, -1, -1], [2, 1, 1]), 'b');
    m.uv.project({ mode: 'planar', axis: 'z', scale: 1, faces: sel.tag('a') });
    m.uv.project({ mode: 'planar', axis: 'z', scale: 0.25, faces: sel.tag('b') });
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    const density = Array.from(measured.value.faceDensity);
    expect(Math.max(...density) / Math.min(...density)).toBeCloseTo(4, 3);
    for (const s of measured.value.faceStretch) expect(s).toBeGreaterThanOrEqual(1);
  });
});

describe('uvHeatmapTexture', () => {
  function projectedPlane(scaleB: number): Model {
    const m = model();
    m.plane({ width: 2, height: 1, widthSegments: 2, heightSegments: 1 });
    m.tag(sel.inBox([-2, -1, -1], [0, 1, 1]), 'a');
    m.tag(sel.inBox([0, -1, -1], [2, 1, 1]), 'b');
    m.uv.project({ mode: 'planar', axis: 'z', scale: 1, faces: sel.tag('a') });
    m.uv.project({ mode: 'planar', axis: 'z', scale: scaleB, faces: sel.tag('b') });
    m.uv.pack({ resolution: 64, padding: 2, method: 'raster', normalize: false });
    return m;
  }

  const colors = (data: Uint8Array): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 255) out.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    return out;
  };

  it('paints a uniform layout in one color and leaves uncovered texels transparent', () => {
    const m = projectedPlane(1);
    const out = uvHeatmapTexture(m.editMesh, { metric: 'density', size: 64 });
    if (!out.ok) throw out.error;
    const data = out.value.data as Uint8Array;
    expect(out.value.shape.extent).toEqual({ width: 64, height: 64 });
    expect(out.value.format).toBe('rgba8unorm-srgb');
    expect(colors(data).size).toBe(1);
    let clear = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 0) clear++;
    expect(clear).toBeGreaterThan(0);
  });

  it('moves a scaled island to another color (falsifier: a constant color ignores density)', () => {
    const uniform = uvHeatmapTexture(projectedPlane(1).editMesh, { metric: 'density', size: 64 });
    const scaled = uvHeatmapTexture(projectedPlane(0.25).editMesh, { metric: 'density', size: 64 });
    if (!uniform.ok || !scaled.ok) throw new Error('heat map failed');
    expect(colors(scaled.value.data as Uint8Array).size).toBeGreaterThan(1);
  });

  it('is deterministic and rejects bad options', () => {
    const m = projectedPlane(0.3);
    const a = uvHeatmapTexture(m.editMesh, { metric: 'stretch', size: 64 });
    const b = uvHeatmapTexture(m.editMesh, { metric: 'stretch', size: 64 });
    if (!a.ok || !b.ok) throw new Error('heat map failed');
    expect(
      Buffer.from(a.value.data as Uint8Array).equals(Buffer.from(b.value.data as Uint8Array)),
    ).toBe(true);
    expect(uvHeatmapTexture(m.editMesh, { metric: 'stretch', size: 0 }).ok).toBe(false);
    expect(uvHeatmapTexture(m.editMesh, { metric: 'stretch', limit: 1 }).ok).toBe(false);
    const bare = model();
    bare.plane({ width: 1, height: 1 });
    expect(uvHeatmapTexture(bare.editMesh, { metric: 'density' }).ok).toBe(false);
  });
});

describe('uvCheckerTexture', () => {
  it('is size x size with alternating squares tinted by position', () => {
    const out = uvCheckerTexture({ size: 64, cells: 8 });
    if (!out.ok) throw out.error;
    const data = out.value.data as Uint8Array;
    expect(data.length).toBe(64 * 64 * 4);
    const px = (x: number, y: number) =>
      Array.from(data.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
    expect(px(0, 0)[2]).toBe(200);
    expect(px(8, 0)[2]).toBe(55);
    expect(px(8, 8)[2]).toBe(200);
    expect(px(48, 0)[0]).toBeGreaterThan(px(0, 0)[0] as number);
    expect(px(0, 48)[1]).toBeGreaterThan(px(0, 0)[1] as number);
    expect(px(3, 3)[3]).toBe(255);
  });

  it('defaults to min(32, size) cells so a small texture is still valid', () => {
    const small = uvCheckerTexture({ size: 4 });
    if (!small.ok) throw small.error;
    const d = small.value.data as Uint8Array;
    expect(d[2]).toBe(200);
    expect(d[4 * 4 + 2]).toBe(55);
    const big = uvCheckerTexture({ size: 64 });
    if (!big.ok) throw big.error;
    const e = big.value.data as Uint8Array;
    expect(e[2]).toBe(200);
    expect(e[2 * 4 + 2]).toBe(55);
    expect(e[1 * 4 + 2]).toBe(200);
  });

  it('is deterministic and rejects bad sizes', () => {
    const a = uvCheckerTexture({ size: 32 });
    const b = uvCheckerTexture({ size: 32 });
    if (!a.ok || !b.ok) throw new Error('checker failed');
    expect(
      Buffer.from(a.value.data as Uint8Array).equals(Buffer.from(b.value.data as Uint8Array)),
    ).toBe(true);
    expect(uvCheckerTexture({ size: 0 }).ok).toBe(false);
    expect(uvCheckerTexture({ size: 16, cells: 32 }).ok).toBe(false);
  });
});

/** Two unit quads side by side (x in [-1, 0] and [0, 1]); `place` writes a square-or-rectangle UV rectangle per face. */
function twoQuads(): Model {
  const m = model();
  m.plane({ width: 2, height: 1, widthSegments: 2, heightSegments: 1 });
  m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
  return m;
}

function place(m: Model, face: number, u0: number, v0: number, su: number, sv: number): void {
  const mesh = m.editMesh;
  const x0 = face === 0 ? -1 : 0;
  for (const h of mesh.faceHalves(face)) {
    const p = mesh.position(mesh.hVert[h] as number);
    mesh.setCorner('uv0', h, [
      u0 + ((p[0] as number) - x0) * su,
      v0 + ((p[1] as number) + 0.5) * sv,
    ]);
  }
}

describe('uvHeatmapTexture exact colors', () => {
  const SIZE = 100;
  const texel = (data: Uint8Array, x: number, y: number) =>
    Array.from(data.slice((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4));

  /** Face 0: side 0.2 at (0.1, 0.1); face 1: side 0.4 at (0.5, 0.1). Row 0 is v = 0. */
  function density(): Uint8Array {
    const m = twoQuads();
    place(m, 0, 0.1, 0.1, 0.2, 0.2);
    place(m, 1, 0.5, 0.1, 0.4, 0.4);
    const out = uvHeatmapTexture(m.editMesh, { metric: 'density', size: SIZE });
    if (!out.ok) throw out.error;
    return out.value.data as Uint8Array;
  }

  it('mean face density is 1 and the 2x island is red-ish, the 0.5x island blue-ish', () => {
    const m = twoQuads();
    place(m, 0, 0.1, 0.1, 0.2, 0.2);
    place(m, 1, 0.5, 0.1, 0.4, 0.4);
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    const [a, b] = Array.from(measured.value.faceDensity) as [number, number];
    expect((a + b) / 2).toBeCloseTo(1, 6);
    expect(b / a).toBeCloseTo(2, 5);
    const data = density();
    // Under-sampled (2/3 of the mean): white toward blue; over-sampled (4/3): white toward red.
    expect(texel(data, 20, 20)).toEqual([202, 212, 234, 255]);
    expect(texel(data, 70, 30)).toEqual([236, 213, 213, 255]);
  });

  it('puts v = 0 on row 0 and keeps a one texel dilated rim opaque', () => {
    const data = density();
    expect(texel(data, 20, 80)[3]).toBe(0);
    expect(texel(data, 70, 80)[3]).toBe(0);
    expect(texel(data, 89, 30)[3]).toBe(255);
    expect(texel(data, 90, 30)).toEqual([236, 213, 213, 255]);
    expect(texel(data, 91, 30)[3]).toBe(0);
    expect(texel(data, 9, 20)).toEqual([202, 212, 234, 255]);
    expect(texel(data, 8, 20)[3]).toBe(0);
  });

  it('colors stretch from green (1) toward red (limit) and leaves uncovered texels clear', () => {
    const m = twoQuads();
    place(m, 0, 0.3, 0.6, 0.4, 0.2);
    place(m, 1, 0.1, 0.1, 0.2, 0.2);
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    expect(measured.value.faceStretch[0]).toBeCloseTo(Math.SQRT2, 5);
    expect(measured.value.faceStretch[1]).toBeCloseTo(1, 5);
    const out = uvHeatmapTexture(m.editMesh, { metric: 'stretch', size: SIZE, limit: 2 });
    if (!out.ok) throw out.error;
    const data = out.value.data as Uint8Array;
    // t = (sqrt 2 - 1) / (2 - 1) = 0.414 of the limit: 83% of the way from green to yellow.
    expect(texel(data, 50, 70)).toEqual([212, 203, 68, 255]);
    expect(texel(data, 20, 20)).toEqual([58, 176, 92, 255]);
    expect(texel(data, 50, 20)[3]).toBe(0);
  });

  it('reports non-finite corners and an empty coverage instead of a blank texture', () => {
    const nan = twoQuads();
    place(nan, 0, 0.1, 0.1, 0.2, 0.2);
    place(nan, 1, 0.5, 0.1, 0.4, 0.4);
    const mesh = nan.editMesh;
    mesh.setCorner('uv0', mesh.faceHalves(0)[0] as number, [Number.NaN, 0]);
    const bad = uvHeatmapTexture(mesh, { metric: 'density' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('model-degenerate');

    const far = twoQuads();
    place(far, 0, 5, 5, 0.2, 0.2);
    place(far, 1, 6, 5, 0.4, 0.4);
    const empty = uvHeatmapTexture(far.editMesh, { metric: 'density' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('model-degenerate');
  });
});

describe('per-face measures and overlap finder internals', () => {
  it('a collapsed face has infinite stretch and zero density', () => {
    const m = twoQuads();
    place(m, 0, 0.3, 0.6, 0.4, 0.2);
    place(m, 1, 0.1, 0.1, 0, 0);
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    expect(measured.value.faceStretch[1]).toBe(Number.POSITIVE_INFINITY);
    expect(measured.value.faceDensity[1]).toBe(0);
  });

  it('finds an overlap whatever the UV winding of either face', () => {
    for (const [mirrorA, mirrorB] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const m = twoQuads();
      place(m, 0, mirrorA ? 0.6 : 0.1, 0.1, mirrorA ? -0.4 : 0.4, 0.4);
      place(m, 1, mirrorB ? 0.7 : 0.2, 0.2, mirrorB ? -0.4 : 0.4, 0.4);
      expect(uvOverlapPairs(m.editMesh, m.editMesh.faces())).toEqual([[0, 1]]);
    }
  });

  it('finds a face nested inside another whatever the UV winding (no edge crosses)', () => {
    for (const [mirrorA, mirrorB] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const m = twoQuads();
      place(m, 0, mirrorA ? 0.9 : 0.1, 0.1, mirrorA ? -0.8 : 0.8, 0.8);
      place(m, 1, mirrorB ? 0.25 : 0.2, 0.45, mirrorB ? -0.05 : 0.05, 0.05);
      expect(uvOverlapPairs(m.editMesh, m.editMesh.faces())).toEqual([[0, 1]]);
    }
  });

  it('ignores triangles of one face that fold over each other', () => {
    const m = model();
    m.plane({ width: 1, height: 1 });
    m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    const mesh = m.editMesh;
    const halves = mesh.faceHalves(0);
    const uv = [
      [0, 0],
      [1, 0],
      [1, 1],
      [1, 0.2],
    ];
    halves.forEach((h, i) => {
      mesh.setCorner('uv0', h, uv[i] as number[]);
    });
    expect(uvOverlapPairs(mesh, mesh.faces())).toEqual([]);
  });
});

describe('uv.pack resolveOverlaps reporting', () => {
  it('reports the true overlap count and warns when the pass cap leaves overlaps', () => {
    // Stacking congruent islands is deliberate overlap, so one pass cannot remove it.
    const m = foldedTube();
    const report = m.uv.pack({
      resolution: 256,
      padding: 4,
      method: 'raster',
      stack: true,
      resolveOverlaps: 1,
    });
    expect(report.status).toBe('ok');
    const facts = info(report);
    const left = uvOverlapPairs(m.editMesh, m.editMesh.faces()).length;
    expect(left).toBe(240);
    expect(facts.overlaps).toBe(left);
    expect(facts.overlapPasses).toBe(1);
    const warns = (report.diagnostics ?? []).filter((d) => d.severity === 'warn');
    expect(warns.length).toBe(1);
    expect(warns[0]?.detail).toMatchObject({ overlaps: 240, overlapPasses: 1 });
  });

  it('does not warn when the repair removes every overlap', () => {
    const report = foldedTube().uv.pack({
      resolution: 256,
      padding: 4,
      method: 'raster',
      resolveOverlaps: 3,
    });
    expect((report.diagnostics ?? []).filter((d) => d.severity === 'warn')).toEqual([]);
  });

  it('cuts every edge of the overlapping faces and reports the cost of the repair', () => {
    const m = foldedTube();
    const report = m.uv.pack({ resolution: 256, padding: 4, method: 'raster', resolveOverlaps: 3 });
    const facts = info(report);
    const metrics = (facts as unknown as { metrics: Record<string, number> }).metrics;
    expect(facts.islandsBefore).toBe(1);
    expect(metrics.islands).toBe(32);
    expect(facts.texelsPerMeterBefore as number).toBeGreaterThan(metrics.texelsPerMeter as number);
    expect(facts.overlaps).toBe(0);
  });
});
