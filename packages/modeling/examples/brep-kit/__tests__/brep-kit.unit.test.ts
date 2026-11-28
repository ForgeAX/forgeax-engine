import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { box, cylinder, extrude } from '../../../src/brep/build.ts';
import { quadrangulate } from '../../../src/brep/quad.ts';
import type { Shape } from '../../../src/brep/types.ts';
import {
  classifyEdges,
  contactSheet,
  countByKind,
  createImage,
  faceUvLoops,
  isoLines,
  type PolyMesh,
  quadNetwork,
  quadStats,
  renderScene,
  renderShape,
  scaledJacobian,
  toPng,
} from '../index.ts';
import type { P3, Scene } from '../scene.ts';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const ngon = (cx: number, cy: number, r: number, n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => [
    cx + r * Math.cos((2 * Math.PI * i) / n),
    cy + r * Math.sin((2 * Math.PI * i) / n),
  ]);

const plate = (): Shape =>
  must(
    extrude({
      profile: [
        [-40, -25],
        [40, -25],
        [40, 25],
        [-40, 25],
      ],
      holes: [ngon(-20, 0, 8, 24), ngon(20, 0, 8, 24)],
      depth: 10,
    }),
  );

const pixel = (
  image: { width: number; rgba: Uint8Array | Uint8ClampedArray },
  x: number,
  y: number,
) => {
  const o = (y * image.width + x) * 4;
  return [image.rgba[o], image.rgba[o + 1], image.rgba[o + 2]];
};

describe('edge classification', () => {
  it('a box has 12 sharp convex edges and nothing else', () => {
    const counts = countByKind(classifyEdges(must(box({ size: [10, 20, 30] }))));
    expect(counts.convex).toBe(12);
    expect(counts.concave + counts.smooth + counts.boundary + counts.seam).toBe(0);
  });

  it('an L profile has exactly one concave vertical edge and five convex ones', () => {
    const l = must(
      extrude({
        profile: [
          [0, 0],
          [20, 0],
          [20, 10],
          [10, 10],
          [10, 20],
          [0, 20],
        ],
        depth: 5,
      }),
    );
    const counts = countByKind(classifyEdges(l));
    expect(counts.concave).toBe(1);
    expect(counts.convex).toBe(5 + 6 + 6);
  });

  it('a polygonal hole: shallow vertical wall edges are smooth, rims are convex', () => {
    const counts = countByKind(classifyEdges(plate()));
    expect(counts.smooth).toBe(48);
    expect(counts.convex).toBe(12 + 96);
  });

  it('a cylinder has two circular rims and one seam', () => {
    const counts = countByKind(classifyEdges(must(cylinder({ radius: 5, height: 10 }))));
    expect(counts.convex).toBe(2);
    expect(counts.seam).toBe(1);
  });
});

describe('iso lines', () => {
  it('clip to the trimmed domain: nothing inside the holes of a plate', () => {
    const shape = plate();
    const top = shape.faces.findIndex((_, f) => faceUvLoops(shape, f).length === 3);
    expect(top).toBeGreaterThanOrEqual(0);
    const lines = isoLines(shape, { count: 12 });
    const inside = lines
      .flatMap((l) => l.points)
      .filter(([, , z]) => Math.abs(z - 10) < 1e-9 || Math.abs(z) < 1e-9)
      .filter(
        ([x, y]) => (x - 20) * (x - 20) + y * y < 56.25 || (x + 20) * (x + 20) + y * y < 56.25,
      );
    expect(inside).toEqual([]);
  });

  it('draws count lines per direction on a full cylinder side and caps', () => {
    const lines = isoLines(must(cylinder({ radius: 5, height: 10 })), { count: 5 });
    expect(lines.length).toBe(30);
  });
});

describe('kit additions', () => {
  it('a per-face iso count function is honoured', () => {
    const cyl = must(cylinder({ radius: 5, height: 10 }));
    const none = isoLines(cyl, { count: () => 0 });
    expect(none.length).toBe(0);
    const side = cyl.faces.findIndex((f) => cyl.surfaces[f.surface]?.kind === 'cylinder');
    const only = isoLines(cyl, { count: (_f, i) => (i === side ? 3 : 0) });
    expect(only.length).toBe(6);
  });

  it('ghost parts add dim surface pixels to a mesh view', () => {
    const q = must(quadrangulate(must(cylinder({ radius: 10, height: 30 })), { size: 3 }));
    const opts = {
      views: ['top' as const],
      modes: ['network' as const],
      size: 160,
      label: false,
      legend: 'none' as const,
    };
    const plain = must(renderShape(q.mesh, opts)).views[0]?.image;
    const ghosted = must(
      renderShape(q.mesh, { ...opts, ghost: [must(box({ size: [60, 60, 4] }))] }),
    ).views[0]?.image;
    let differing = 0;
    for (let i = 0; i < (plain?.rgba.length ?? 0); i += 4) {
      if (plain?.rgba[i] !== ghosted?.rgba[i] || plain?.rgba[i + 1] !== ghosted?.rgba[i + 1])
        differing++;
    }
    expect(differing).toBeGreaterThan(100);
  });
});

describe('scaled Jacobian', () => {
  it('scores square 1, 60 degree rhombus sin 60, equilateral triangle 1, bow-tie and sliver at most 0.1', () => {
    expect(
      scaledJacobian([
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ]),
    ).toBeCloseTo(1, 12);
    const h = Math.sqrt(3) / 2;
    expect(
      scaledJacobian([
        [0, 0, 0],
        [1, 0, 0],
        [1.5, h, 0],
        [0.5, h, 0],
      ]),
    ).toBeCloseTo(h, 12);
    expect(
      scaledJacobian([
        [0, 0, 0],
        [1, 0, 0],
        [0.5, h, 0],
      ]),
    ).toBeCloseTo(1, 12);
    expect(
      scaledJacobian([
        [0, 0, 0],
        [1, 1, 0],
        [1, 0, 0],
        [0, 1, 0],
      ]),
    ).toBeLessThanOrEqual(0.1);
    expect(
      scaledJacobian([
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ]),
    ).toBe(0);
  });
});

describe('quad network', () => {
  const fan = (): PolyMesh => {
    const positions: P3[] = [[0, 0, 0]];
    for (let i = 0; i < 5; i++) {
      const a = (2 * Math.PI * i) / 5;
      positions.push([Math.cos(a), Math.sin(a), 0]);
      const b = (2 * Math.PI * (i + 0.5)) / 5;
      positions.push([1.4 * Math.cos(b), 1.4 * Math.sin(b), 0]);
    }
    const faces = Array.from({ length: 5 }, (_, i) => [
      0,
      1 + 2 * i,
      2 + 2 * i,
      1 + ((2 * i + 2) % 10),
    ]);
    return { positions, faces };
  };

  it('marks a valence-5 interior vertex and nothing else', () => {
    const stats = quadStats(fan());
    expect(stats.singular).toEqual({ 5: 1 });
    expect(stats.singularTotal).toBe(1);
    const scene = quadNetwork(fan());
    expect(scene.markers.length).toBe(1);
    expect(scene.markers[0]?.p).toEqual([0, 0, 0]);
  });

  it('a box quadrangulation has no singular vertices, only eight feature corners', () => {
    const q = must(quadrangulate(must(box({ size: [20, 14, 10] })), { size: 3 }));
    const stats = quadStats(q.mesh);
    expect(stats.singularTotal).toBe(0);
    expect(stats.featureCorners).toBe(8);
    expect(stats.quads).toBe(q.report.quads);
    expect(stats.jacobianMin).toBeCloseTo(1, 9);
  });

  it('a cylinder quadrangulation reports its valence-3 cap singularities and a lower Jacobian there', () => {
    const q = must(quadrangulate(must(cylinder({ radius: 10, height: 30 })), { size: 3 }));
    const stats = quadStats(q.mesh);
    expect(stats.singular[3]).toBe(8);
    expect(stats.jacobianMin).toBeLessThan(0.9);
    expect(stats.jacobianMin).toBeCloseTo(q.report.scaledJacobian.min, 6);
  });
});

describe('rasterizer', () => {
  const tri: Scene = {
    tris: [
      { a: [-1, 0, -1], b: [1, 0, -1], c: [0, 0, 1], color: [200, 60, 60], unlit: true },
      { a: [-1, 0, 1], b: [1, 0, 1], c: [0, 0, -1], color: [200, 60, 60], unlit: true },
    ],
    lines: [],
    markers: [],
  };

  it('hides a line behind a surface, shows it in front, and is byte-stable', () => {
    const wall: Scene = {
      tris: [
        { a: [-2, 0, -2], b: [2, 0, -2], c: [2, 0, 2], color: [0, 200, 0], unlit: true },
        { a: [-2, 0, -2], b: [2, 0, 2], c: [-2, 0, 2], color: [0, 200, 0], unlit: true },
      ],
      lines: [],
      markers: [],
    };
    const line = (y: number): Scene['lines'] => [
      {
        points: [
          [-1, y, 0],
          [1, y, 0],
        ],
        color: [255, 0, 0],
        width: 3,
      },
    ];
    const opts = { size: 128, fill: 0.9 };
    const behind = renderScene({ ...wall, lines: line(1) }, 'front', opts);
    const front = renderScene({ ...wall, lines: line(-1) }, 'front', opts);
    const mid = 64 * 128 + 64;
    expect(pixel(behind, 64, 64)).toEqual([0, 200, 0]);
    expect(pixel(front, 64, 64)?.[0]).toBeGreaterThan(200);
    expect(mid).toBeGreaterThan(0);
    expect(Buffer.from(toPng(renderScene({ ...wall, lines: line(-1) }, 'front', opts)))).toEqual(
      Buffer.from(toPng(front)),
    );
    expect(renderScene(tri, 'front', opts).width).toBe(128);
  });

  it('a singular-vertex marker changes the pixels around it', () => {
    const base: Scene = {
      tris: [],
      lines: [
        {
          points: [
            [-1, 0, 0],
            [1, 0, 0],
          ],
          color: [255, 255, 255],
          width: 1,
        },
      ],
      markers: [],
    };
    const withMarker: Scene = {
      ...base,
      markers: [{ p: [0, 0, 0], color: [255, 128, 0], radius: 6 }],
    };
    const a = renderScene(base, 'front', { size: 96 });
    const b = renderScene(withMarker, 'front', { size: 96 });
    expect(pixel(b, 48, 44)).not.toEqual(pixel(a, 48, 44));
  });
});

describe('renderShape and contactSheet', () => {
  it('writes every mode x view PNG and is deterministic', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'brep-kit-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'brep-kit-b-'));
    try {
      const shape = plate();
      const a = must(renderShape(shape, { outDir: dirA, size: 160, silhouette: true }));
      must(renderShape(shape, { outDir: dirB, size: 160, silhouette: true }));
      expect(a.views.length).toBe(12);
      const files = readdirSync(dirA).sort();
      expect(files.length).toBe(12);
      expect(files).toContain('features-iso.png');
      for (const f of files)
        expect(readFileSync(join(dirA, f)).equals(readFileSync(join(dirB, f)))).toBe(true);
      expect(a.summary.edges.convex).toBe(108);
      const png = readFileSync(join(dirA, 'shaded-iso.png'));
      expect([...png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    } finally {
      rmSync(dirA, { recursive: true });
      rmSync(dirB, { recursive: true });
    }
  });

  it('features differ from shaded: edge colours appear only in the feature view', () => {
    const r = must(
      renderShape(must(box({ size: [10, 10, 10] })), {
        views: ['iso'],
        size: 200,
        label: false,
        legend: 'none',
      }),
    );
    const find = (mode: string) =>
      r.views.find((v) => v.mode === mode)?.image as { rgba: Uint8Array };
    const amber = (img: { rgba: Uint8Array }): number => {
      let n = 0;
      for (let i = 0; i < img.rgba.length; i += 4)
        if (
          (img.rgba[i] as number) > 200 &&
          (img.rgba[i + 1] as number) > 150 &&
          (img.rgba[i + 2] as number) < 120
        )
          n++;
      return n;
    };
    expect(amber(find('features'))).toBeGreaterThan(100);
    expect(amber(find('shaded'))).toBe(0);
  });

  it('meshes default to shaded, network and jacobian and report quad stats', () => {
    const q = must(quadrangulate(must(cylinder({ radius: 10, height: 30 })), { size: 3 }));
    const r = must(renderShape(q.mesh, { views: ['iso'], size: 160 }));
    expect(r.views.map((v) => v.mode)).toEqual(['shaded', 'network', 'jacobian']);
    expect(r.summary.quad?.singular[3]).toBe(8);
  });

  it('contact sheet size follows the grid, repeats byte-for-byte, and captions change pixels', () => {
    const cell = createImage(40, 40, [50, 60, 70]);
    const cells = Array.from({ length: 5 }, (_, i) => ({ image: cell, caption: `cell ${i}` }));
    const s1 = contactSheet(cells, { columns: 3, cell: 40, title: 'T' });
    const s2 = contactSheet(cells, { columns: 3, cell: 40, title: 'T' });
    expect(Buffer.from(s1.rgba).equals(Buffer.from(s2.rgba))).toBe(true);
    expect(s1.width).toBe(3 * (40 + 8) + 8);
    const s3 = contactSheet(
      cells.map((c) => ({ ...c, caption: 'other' })),
      { columns: 3, cell: 40, title: 'T' },
    );
    expect(Buffer.from(s3.rgba).equals(Buffer.from(s1.rgba))).toBe(false);
  });
});
