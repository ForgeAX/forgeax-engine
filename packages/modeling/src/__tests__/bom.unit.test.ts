import { describe, expect, it } from 'vitest';
import { type BomItem, bom, bomTable } from '../bom';
import { EditMesh } from '../mesh';

function cube(center: readonly [number, number, number] = [0, 0, 0]): EditMesh {
  const mesh = new EditMesh();
  const [cx, cy, cz] = center;
  const vertices = [
    [-0.5, -0.5, -0.5],
    [0.5, -0.5, -0.5],
    [0.5, 0.5, -0.5],
    [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5],
    [0.5, -0.5, 0.5],
    [0.5, 0.5, 0.5],
    [-0.5, 0.5, 0.5],
  ].map(([x, y, z]) => mesh.addVertex((x as number) + cx, (y as number) + cy, (z as number) + cz));
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
  ];
  for (const quad of quads) {
    const loop = quad.map((index) => vertices[index] as number);
    const added = mesh.addFace(loop);
    if (!added.ok) throw added.error;
  }
  return mesh;
}

function rectangle(width: number, height: number): EditMesh {
  const mesh = new EditMesh();
  const vertices = [
    mesh.addVertex(0, 0, 0),
    mesh.addVertex(width, 0, 0),
    mesh.addVertex(width, height, 0),
    mesh.addVertex(0, height, 0),
  ];
  const added = mesh.addFace(vertices);
  if (!added.ok) throw added.error;
  return mesh;
}

function report(items: readonly BomItem[]) {
  const result = bom(items);
  if (!result.ok) throw result.error;
  return result.value;
}

const steel = { name: 'steel', density: 7850 } as const;

describe('bom', () => {
  it('weighs a closed unit cube in steel and reports its centre of mass', () => {
    const result = report([{ id: 'cube', material: steel, geometry: { solid: cube() } }]);
    expect(result.pass).toBe(true);
    expect(result.rows[0]?.volume).toBeCloseTo(1, 12);
    expect(result.rows[0]?.unitMass).toBeCloseTo(7850, 9);
    expect(result.rows[0]?.mass).toBeCloseTo(7850, 9);
    expect(result.rows[0]?.centroid?.[0]).toBeCloseTo(0, 12);
    expect(result.rows[0]?.centroid?.[1]).toBeCloseTo(0, 12);
    expect(result.rows[0]?.centroid?.[2]).toBeCloseTo(0, 12);
  });

  it('weighs a flat sheet by surface area, gauge and density', () => {
    const result = report([
      { id: 'skin', material: steel, geometry: { sheet: rectangle(1, 2), gauge: 0.0008 } },
    ]);
    expect(result.rows[0]?.area).toBeCloseTo(2, 12);
    expect(result.rows[0]?.unitMass).toBeCloseTo(12.56, 12);
    expect(result.rows[0]?.centroid).toEqual([0.5, 1, 0]);
  });

  it('rolls up a three-level product tree, quantities, breakdowns and centroids', () => {
    const result = report([
      { id: 'body', name: 'Body', material: steel, process: 'purchase', geometry: { mass: 0.5 } },
      {
        id: 'door',
        name: 'Door',
        parent: 'body',
        quantity: 2,
        material: steel,
        process: 'stamp',
        geometry: { sheet: rectangle(1, 2), gauge: 0.0008 },
      },
      {
        id: 'hinge',
        name: 'Hinge',
        parent: 'door',
        quantity: 2,
        material: steel,
        process: 'purchase',
        geometry: { mass: 0.25 },
      },
    ]);
    const [body, door, hinge] = result.rows;
    expect(door?.mass).toBeCloseTo(13.06, 12);
    expect(body?.mass).toBeCloseTo(26.62, 12);
    expect(hinge?.count).toBe(4);
    expect(result.totals.parts).toBe(7);
    expect(result.totals.mass).toBeCloseTo(26.62, 12);
    expect(result.totals.byMaterial.reduce((sum, row) => sum + row.mass, 0)).toBeCloseTo(
      result.totals.mass,
      12,
    );
    expect(result.totals.byProcess.reduce((sum, row) => sum + row.mass, 0)).toBeCloseTo(
      result.totals.mass,
      12,
    );
    expect(result.totals.byMaterial.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 12);
    expect(result.totals.byProcess.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 12);
    expect(body?.centroid).toBeUndefined();

    const assembly = report([
      { id: 'assembly' },
      { id: 'left', parent: 'assembly', geometry: { solid: cube([0, 0, 0]) }, material: steel },
      {
        id: 'right',
        parent: 'assembly',
        geometry: { solid: cube([2, 0, 0]) },
        material: { name: 'dense alloy', density: 15700 },
      },
    ]);
    expect(assembly.rows[0]?.mass).toBeCloseTo(23550, 9);
    expect(assembly.rows[0]?.centroid?.[0]).toBeCloseTo(4 / 3, 12);
    expect(assembly.rows[0]?.centroid?.[1]).toBeCloseTo(0, 12);
    expect(assembly.rows[0]?.centroid?.[2]).toBeCloseTo(0, 12);
  });

  it('reports an open solid, returns its row and counts its mass as zero', () => {
    const open = cube();
    open.removeFace(open.faces()[0] as number);
    const result = report([{ id: 'open', material: steel, geometry: { solid: open } }]);
    expect(result.pass).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('bom-open-solid');
    expect(result.issues.every((issue) => issue.severity === 'error')).toBe(true);
    expect(result.rows.map((row) => row.id)).toEqual(['open']);
    expect(result.rows[0]?.unitMass).toBe(0);
    expect(result.rows[0]?.area).toBeCloseTo(5, 12);
    expect(result.rows[0]?.volume).toBeUndefined();
    expect(result.totals.mass).toBe(0);
  });

  it('reports missing material and gives the surviving geometry row zero mass', () => {
    const result = report([{ id: 'skin', geometry: { sheet: rectangle(1, 2), gauge: 0.001 } }]);
    expect(result.pass).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['bom-missing-material']);
    expect(result.issues.every((issue) => issue.severity === 'error')).toBe(true);
    expect(result.rows.map((row) => row.id)).toEqual(['skin']);
    expect(result.rows[0]?.area).toBeCloseTo(2, 12);
    expect(result.rows[0]?.unitMass).toBe(0);
  });

  it('reports both missing material and an open solid', () => {
    const open = cube();
    open.removeFace(open.faces()[0] as number);
    const result = report([{ id: 'open', geometry: { solid: open } }]);
    expect(result.pass).toBe(false);
    expect(result.issues.map((issue) => issue.code).sort()).toEqual([
      'bom-missing-material',
      'bom-open-solid',
    ]);
    expect(result.rows.map((row) => row.id)).toEqual(['open']);
    expect(result.rows[0]?.unitMass).toBe(0);
  });

  it('reports an unknown parent and treats its item as a root', () => {
    const result = report([{ id: 'part', parent: 'missing', geometry: { mass: 2 } }]);
    expect(result.pass).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['bom-unknown-parent']);
    expect(result.issues.every((issue) => issue.severity === 'error')).toBe(true);
    expect(result.rows.map((row) => [row.id, row.depth, row.parent])).toEqual([
      ['part', 0, undefined],
    ]);
    expect(result.totals.mass).toBe(2);
  });

  it('reports each cycle once and leaves cyclic items out of rows', () => {
    const result = report([
      { id: 'a', parent: 'b', geometry: { mass: 2 } },
      { id: 'b', parent: 'a', geometry: { mass: 3 } },
      { id: 'kept', geometry: { mass: 5 } },
    ]);
    expect(result.pass).toBe(false);
    expect(result.issues.filter((issue) => issue.code === 'bom-cycle')).toHaveLength(1);
    expect(result.issues.every((issue) => issue.severity === 'error')).toBe(true);
    expect(result.rows.map((row) => row.id)).toEqual(['kept']);
    expect(result.totals.mass).toBe(5);
  });

  it('keeps the first duplicate id and reports the duplicate', () => {
    const result = report([
      { id: 'part', geometry: { mass: 2 } },
      { id: 'part', geometry: { mass: 99 } },
      { id: 'child', parent: 'part', geometry: { mass: 1 } },
    ]);
    expect(result.pass).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['bom-duplicate-id']);
    expect(result.issues.every((issue) => issue.severity === 'error')).toBe(true);
    expect(result.rows.map((row) => row.id)).toEqual(['part', 'child']);
    expect(result.rows[1]?.count).toBe(1);
    expect(result.rows[0]?.mass).toBe(3);
    expect(result.totals.mass).toBe(3);
  });

  it.each([
    ['empty id', [{ id: '   ' }]],
    ['zero density', [{ id: 'part', material: { name: 'steel', density: 0 } }]],
    ['non-finite density', [{ id: 'part', material: { name: 'steel', density: Number.NaN } }]],
    ['zero gauge', [{ id: 'part', geometry: { sheet: rectangle(1, 1), gauge: 0 } }]],
    ['non-finite gauge', [{ id: 'part', geometry: { sheet: rectangle(1, 1), gauge: Infinity } }]],
    ['zero quantity', [{ id: 'part', quantity: 0 }]],
    ['fractional quantity', [{ id: 'part', quantity: 1.5 }]],
    ['non-finite quantity', [{ id: 'part', quantity: Number.NaN }]],
    ['negative mass', [{ id: 'part', geometry: { mass: -1 } }]],
    ['non-finite mass', [{ id: 'part', geometry: { mass: Infinity } }]],
  ] as const)('returns model-invalid-argument for %s', (_case, items) => {
    const result = bom(items as readonly BomItem[]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('model-invalid-argument');
  });

  it('formats the report table with fixed columns and exact numeric precision', () => {
    const result = report([
      {
        id: 'skin',
        name: 'Door skin',
        material: steel,
        process: 'stamp',
        geometry: { sheet: rectangle(1, 2), gauge: 0.0008 },
      },
    ]);
    expect(bomTable(result)).toEqual([
      [
        'id',
        'name',
        'parent',
        'depth',
        'quantity',
        'count',
        'material',
        'process',
        'gauge (mm)',
        'area (m²)',
        'volume (m³)',
        'unit mass (kg)',
        'mass (kg)',
        'centroid (m)',
      ],
      [
        'skin',
        'Door skin',
        '-',
        '0',
        '1',
        '1',
        'steel',
        'stamp',
        '0.80',
        '2',
        '-',
        '12.560',
        '12.560',
        '0.5 1 0',
      ],
    ]);
  });

  it('changes only depth-first row order when siblings are reordered', () => {
    const items: BomItem[] = [
      { id: 'root' },
      { id: 'one', parent: 'root', geometry: { mass: 1 }, process: 'buy' },
      { id: 'two', parent: 'root', geometry: { mass: 2 }, process: 'buy' },
    ];
    const original = report(items);
    const reordered = report([items[0] as BomItem, items[2] as BomItem, items[1] as BomItem]);
    expect(reordered.rows.map((row) => row.id)).toEqual(['root', 'two', 'one']);
    expect(reordered.rows.map((row) => [row.id, row.mass])).toEqual([
      ['root', 3],
      ['two', 2],
      ['one', 1],
    ]);
    expect(original.rows.map((row) => [row.id, row.mass])).toEqual([
      ['root', 3],
      ['one', 1],
      ['two', 2],
    ]);
    expect(reordered.totals).toEqual(original.totals);
    expect(reordered.rows[0]?.mass).toBe(original.rows[0]?.mass);
    expect(reordered.rows[0]?.centroid).toEqual(original.rows[0]?.centroid);
    expect(reordered.issues).toEqual(original.issues);
    expect(reordered.pass).toBe(original.pass);
  });
});
