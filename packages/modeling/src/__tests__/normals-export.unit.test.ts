import {
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { describe, expect, it } from 'vitest';
import { bakeMaps, bakeSources } from '../bake';
import { sha256 } from '../compute/sha256';
import { exportMesh, type NormalMode } from '../finish';
import { type Model, model } from '../model';
import type { NurbsSurface } from '../nurbs';
import { sel } from '../selectors';

/**
 * U51 gates: weighted normals with bevel borrowing keep the large faces of a chamfered box
 * flat; transferred normals reproduce a curved source on a flat low poly. Existing modes
 * keep their output.
 */

function attributes(m: Model, normals: NormalMode) {
  const exported = exportMesh(m.editMesh, { normals });
  if (!exported.ok) throw exported.error;
  const a = unpackInterleavedVertexAttributes(
    exported.value.mesh.vertices,
    deriveVertexLayoutProjection(exported.value.mesh.attributes),
  ) as unknown as Record<string, Float32Array>;
  return { position: a.position as Float32Array, normal: a.normal as Float32Array };
}

const degrees = (a: readonly number[], b: readonly number[]) => {
  const d =
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number);
  const l = Math.hypot(...(a as number[])) * Math.hypot(...(b as number[]));
  return (Math.acos(Math.min(1, Math.max(-1, d / l))) * 180) / Math.PI;
};

describe('weighted normals with bevel borrowing (U51, gate)', () => {
  const box = () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.bevel(sel.edges.all(), { width: 0.01, segments: 1 });
    m.uv.project({ mode: 'box', scale: 1 });
    return m;
  };
  /** Largest angle between a vertex normal on a large face and that face's normal. */
  const largeFaceError = (normals: NormalMode) => {
    const { position, normal } = attributes(box(), normals);
    let worst = 0;
    for (let i = 0; i < position.length / 3; i++) {
      const p = [position[i * 3], position[i * 3 + 1], position[i * 3 + 2]] as number[];
      // A vertex of a large face lies on its plane (|coordinate| = 0.5) inside the chamfer band.
      for (let c = 0; c < 3; c++) {
        if (Math.abs(Math.abs(p[c] as number) - 0.5) > 1e-6) continue;
        const face = [0, 0, 0];
        face[c] = Math.sign(p[c] as number);
        const n = [normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]] as number[];
        if (degrees(n, face) < 30) worst = Math.max(worst, degrees(n, face));
      }
    }
    return worst;
  };

  it('a 1 cm chamfer on a 1 m box leaves the large faces within 0.5 degrees of flat; area weighting alone or smooth normals bend them (falsifier)', () => {
    // Measured: 0 degrees with bevelBorrow, 0.81 with area weighting alone, 28.9 smooth.
    expect(largeFaceError({ mode: 'weighted', bevelBorrow: 60 })).toBeLessThanOrEqual(0.5);
    expect(largeFaceError({ mode: 'weighted' })).toBeGreaterThan(0.5);
    expect(largeFaceError({ mode: 'smooth' })).toBeGreaterThan(10);
  });

  it('faceWeight scales tagged faces; malformed settings are invalid arguments', () => {
    const m = box();
    m.tag(sel.facing('+y', 1), 'top');
    const heavy = attributes(m, { mode: 'weighted', faceWeight: { top: 1000 } });
    const plain = attributes(m, { mode: 'weighted' });
    expect(Array.from(heavy.normal)).not.toEqual(Array.from(plain.normal));
    for (const normals of [
      { mode: 'weighted', bevelBorrow: 200 },
      { mode: 'weighted', faceWeight: { top: -1 } },
    ] as NormalMode[]) {
      expect(exportMesh(m.editMesh, { normals })).toMatchObject({
        ok: false,
        error: { code: 'model-invalid-argument' },
      });
    }
    // A transfer source that is not an FXEM snapshot fails like any snapshot operand.
    expect(
      exportMesh(m.editMesh, { normals: { mode: 'transfer', from: new Uint8Array([1, 2, 3]) } }),
    ).toMatchObject({ ok: false, error: { code: 'model-precondition' } });
  });

  it("'surface' keeps the default weighted grouping and weights away from patches; the weighted options do not reach it", () => {
    const m = box();
    m.tag(sel.facing('+y', 1), 'top');
    const surface = Array.from(attributes(m, { mode: 'surface' }).normal);
    expect(surface).toEqual(Array.from(attributes(m, { mode: 'weighted' }).normal));
    const borrowed = attributes(m, { mode: 'weighted', bevelBorrow: 60 }).normal;
    const heavy = attributes(m, { mode: 'weighted', faceWeight: { top: 1000 } }).normal;
    expect(surface).not.toEqual(Array.from(borrowed));
    expect(surface).not.toEqual(Array.from(heavy));
  });

  it("'surface' on m.surface patches plus plain faces exports the same normals as before U51 (pinned digest)", () => {
    const w = Math.SQRT1_2;
    const quarter = (z0: number, z1: number): NurbsSurface => ({
      degreeU: 2,
      degreeV: 1,
      points: [
        [
          [0.3, 0, z0],
          [0.3, 0, z1],
        ],
        [
          [0.3, 0.3, z0],
          [0.3, 0.3, z1],
        ],
        [
          [0, 0.3, z0],
          [0, 0.3, z1],
        ],
      ],
      weights: [
        [1, 1],
        [w, w],
        [1, 1],
      ],
      knotsU: [0, 0, 0, 1, 1, 1],
      knotsV: [0, 0, 1, 1],
    });
    const m = model();
    m.surface({
      patches: [
        { name: 'half0', surface: quarter(0, 0.1) },
        { name: 'half1', surface: quarter(0.1, 0.2) },
      ],
      chord: 0.004,
    });
    m.box({ size: [0.1, 0.1, 0.1], center: [0.6, 0, 0] });
    m.bevel(sel.edges.dihedral('>', 80), { width: 0.005, segments: 1 });
    m.uv.project({ mode: 'box', scale: 1 });
    const mesh = m.editMesh;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        if (mesh.corner('uv1', h) === undefined) mesh.setCorner('uv1', h, [0, 0]);
      }
    }
    const r = m.toMesh({ normals: { mode: 'surface' } });
    if (!r.ok) throw r.error;
    // Exact patch normals on 40 corners, the default weighted normal on the box's 56.
    expect(r.value.report.exactNormals).toEqual([40, 96]);
    const n = r.value.mesh.attributes.normal as Float32Array;
    // Digest of these normals on main 91cc48b, before U51.
    expect(sha256(new Uint8Array(n.buffer, n.byteOffset, n.byteLength))).toBe(
      '2ebc4607063bbf96e7ff19044435615fefe50d14fd0c4a04e41d01a3d186ad16',
    );
  });
});

describe('normal transfer (U51, gate)', () => {
  it('a flat 8 x 8 grid takes the normals of a dome under it within 1 degree; its own smooth normals stay flat (falsifier)', () => {
    const R = 2;
    const dome = model();
    dome.sphere({ radius: R, widthSegments: 128, heightSegments: 64 });
    dome.translate(sel.all(), [0, 0, -R + 0.1]);
    dome.uv.project({ mode: 'box', scale: 1 });
    const grid = model();
    grid.plane({ width: 1, height: 1, widthSegments: 8, heightSegments: 8 });
    grid.translate(sel.all(), [0, 0, 0.05]);
    grid.uv.project({ mode: 'box', scale: 1 });
    const errors = (normals: NormalMode) => {
      const { position, normal } = attributes(grid, normals);
      const out: number[] = [];
      for (let i = 0; i < position.length / 3; i++) {
        const p = [
          position[i * 3],
          position[i * 3 + 1],
          (position[i * 3 + 2] as number) + R - 0.1,
        ] as number[];
        out.push(degrees([normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]] as number[], p));
      }
      return out;
    };
    const transferred = errors({ mode: 'transfer', from: dome.snapshot() });
    // Measured: max 0.06 degrees; the grid's own (flat) normals are off by up to 19.9.
    expect(Math.max(...transferred)).toBeLessThan(1);
    expect(Math.max(...errors({ mode: 'smooth' }))).toBeGreaterThan(10);
    // The bake frames the base with the same transferred normals, through JSON params too.
    const normals = { mode: 'transfer', from: dome.snapshot() } as const;
    const baked = bakeMaps({
      base: grid,
      detail: grid,
      maps: ['normal'],
      resolution: 16,
      normals,
      detailNormals: normals,
    });
    if (!baked.ok) throw baked.error;
    // The base onto itself under one normal field is a flat tangent map.
    expect(baked.value.provenance.covered).toBeGreaterThan(0);
    const flat = baked.value.textures.normal?.data as Uint8Array;
    for (let i = 0; i < 16 * 16; i++) expect(flat[i * 4 + 2]).toBeGreaterThanOrEqual(250);
    const sources = bakeSources({
      base: grid,
      detail: grid,
      maps: ['normal'],
      resolution: 16,
      normals,
      key: 'transfer',
    });
    if (!sources.ok) throw sources.error;
    const params = (
      JSON.parse(JSON.stringify(sources.value['texture/transfer-normal']?.source)) as {
        params: { baseNormals: { from: unknown } };
      }
    ).params;
    expect(typeof params.baseNormals.from).toBe('string');
  });
});
