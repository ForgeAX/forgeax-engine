import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import {
  faceArea,
  facePoints,
  facesArea,
  type Tuple3,
  triangleArea,
  triangulateLoop,
} from './geom';
import { solidProperties } from './mass';
import type { EditMesh } from './mesh';
import type { Issue } from './report';

/** Material data used to estimate a part's mass. Density is in kg/m^3. */
export interface BomMaterial {
  readonly name: string;
  /** kg/m^3 */
  readonly density: number;
}

/** Geometry from which one item's mass can be estimated. */
export type BomGeometry =
  | { readonly solid: EditMesh }
  | { readonly sheet: EditMesh; readonly gauge: number }
  | { readonly mass: number };

/** One item in a product tree. */
export interface BomItem {
  readonly id: string;
  readonly name?: string;
  readonly parent?: string;
  /** Manufacturing process name, e.g. 'stamping'; the report groups mass by it. */
  readonly process?: string;
  /** Count of this item in its parent (default 1, a positive integer). */
  readonly quantity?: number;
  readonly material?: BomMaterial;
  /** Absent for a pure assembly node. */
  readonly geometry?: BomGeometry;
}

/** Structural and material findings reported by {@link bom}. */
export type BomCode =
  | 'bom-open-solid'
  | 'bom-missing-material'
  | 'bom-unknown-parent'
  | 'bom-cycle'
  | 'bom-duplicate-id';

/** One item with its own and rolled-up mass properties. */
export interface BomRow {
  readonly id: string;
  readonly name: string;
  readonly parent?: string;
  readonly process?: string;
  readonly depth: number;
  readonly quantity: number;
  readonly count: number;
  readonly material?: string;
  readonly gauge?: number;
  readonly area?: number;
  readonly volume?: number;
  readonly unitMass: number;
  readonly mass: number;
  readonly centroid?: Tuple3;
}

/** Mass report, parts summary and per-material/process breakdown. */
export interface BomReport {
  readonly pass: boolean;
  readonly rows: readonly BomRow[];
  readonly totals: {
    readonly mass: number;
    readonly parts: number;
    readonly byMaterial: readonly {
      readonly name: string;
      readonly mass: number;
      readonly share: number;
    }[];
    readonly byProcess: readonly {
      readonly name: string;
      readonly mass: number;
      readonly share: number;
    }[];
  };
  readonly issues: readonly Issue<BomCode>[];
}

interface Node {
  readonly item: BomItem;
  readonly index: number;
  readonly quantity: number;
  readonly parent?: string;
}

interface GeometryMeasure {
  readonly unitMass: number;
  readonly area?: number;
  readonly volume?: number;
  readonly centroid?: Tuple3;
  readonly hasPart: boolean;
}

interface Rollup {
  readonly mass: number;
  readonly centroid?: Tuple3;
  readonly hasParts: boolean;
}

function invalid(field: string, id: string, value: unknown, expected: string): ModelingError {
  return modelingError('model-invalid-argument', expected, { field, id, value });
}

function validate(items: readonly BomItem[]): Result<void, ModelingError> {
  for (const item of items) {
    if (item.id.trim().length === 0)
      return err(invalid('id', item.id, item.id, 'a non-empty item id'));
    const quantity = item.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return err(invalid('quantity', item.id, quantity, 'a positive integer quantity'));
    }
    if (
      item.material !== undefined &&
      (!Number.isFinite(item.material.density) || item.material.density <= 0)
    ) {
      return err(
        invalid(
          'density',
          item.id,
          item.material.density,
          'a positive finite material density in kg/m^3',
        ),
      );
    }
    const geometry = item.geometry;
    if (geometry !== undefined && 'sheet' in geometry) {
      if (!Number.isFinite(geometry.gauge) || geometry.gauge <= 0) {
        return err(
          invalid('gauge', item.id, geometry.gauge, 'a positive finite sheet gauge in meters'),
        );
      }
    }
    if (geometry !== undefined && 'mass' in geometry) {
      if (!Number.isFinite(geometry.mass) || geometry.mass < 0) {
        return err(
          invalid('mass', item.id, geometry.mass, 'a finite non-negative purchased mass in kg'),
        );
      }
    }
    if (geometry !== undefined && 'solid' in geometry) {
      for (const vertex of geometry.solid.vertices()) {
        const position = geometry.solid.position(vertex);
        if (!position.every(Number.isFinite)) {
          return err(invalid('solid', item.id, position, 'a finite closed solid mesh'));
        }
      }
    }
    if (geometry !== undefined && 'sheet' in geometry) {
      for (const vertex of geometry.sheet.vertices()) {
        const position = geometry.sheet.position(vertex);
        if (!position.every(Number.isFinite)) {
          return err(invalid('sheet', item.id, position, 'a sheet mesh with finite vertices'));
        }
      }
    }
  }
  return ok(undefined);
}

function sheetCentroid(
  mesh: EditMesh,
  faces: readonly number[],
  totalArea: number,
): Tuple3 | undefined {
  if (!(totalArea > 0)) return undefined;
  const weighted: Tuple3 = [0, 0, 0];
  let areaSum = 0;
  for (const face of faces) {
    const points = facePoints(mesh, face);
    const origin = points[0];
    if (origin === undefined) continue;
    let faceAreaSum = 0;
    const faceWeighted: Tuple3 = [0, 0, 0];
    const triangles = triangulateLoop(points);
    if (triangles === undefined) continue;
    for (let i = 0; i < triangles.length; i += 3) {
      const a = points[triangles[i] as number] as Tuple3;
      const b = points[triangles[i + 1] as number] as Tuple3;
      const c = points[triangles[i + 2] as number] as Tuple3;
      const area = triangleArea(a, b, c);
      faceAreaSum += area;
      for (let axis = 0; axis < 3; axis++) {
        faceWeighted[axis] =
          (faceWeighted[axis] as number) +
          (area * ((a[axis] as number) + (b[axis] as number) + (c[axis] as number))) / 3;
      }
    }
    if (!(faceAreaSum > 0)) continue;
    const area = faceArea(mesh, face);
    areaSum += area;
    for (let axis = 0; axis < 3; axis++) {
      weighted[axis] =
        (weighted[axis] as number) + ((faceWeighted[axis] as number) / faceAreaSum) * area;
    }
  }
  return areaSum > 0
    ? [weighted[0] / areaSum, weighted[1] / areaSum, weighted[2] / areaSum]
    : undefined;
}

function isOpen(mesh: EditMesh, faces: readonly number[]): boolean {
  const faceSet = new Set(faces);
  return (
    faces.length === 0 ||
    faces.some((face) =>
      mesh.faceHalves(face).some((half) => !faceSet.has(mesh.hFace[half ^ 1] as number)),
    )
  );
}

function measureGeometry(
  node: Node,
  issues: Issue<BomCode>[],
): Result<GeometryMeasure, ModelingError> {
  const { item } = node;
  const geometry = item.geometry;
  if (geometry === undefined) return ok({ unitMass: 0, hasPart: false });
  if ('mass' in geometry) return ok({ unitMass: geometry.mass, hasPart: true });
  const missingMaterial = item.material === undefined;
  if (missingMaterial) {
    issues.push({ code: 'bom-missing-material', severity: 'error', detail: { id: item.id } });
  }
  if ('solid' in geometry) {
    const mesh = geometry.solid;
    const faces = mesh.faces();
    const props = solidProperties(mesh, faces, item.material?.density ?? 1);
    if (!props.ok) {
      if (props.error.code !== 'model-precondition' || !isOpen(mesh, faces))
        return err(props.error);
      issues.push({ code: 'bom-open-solid', severity: 'error', detail: { id: item.id } });
      return ok({ unitMass: 0, area: facesArea(mesh, faces), hasPart: true });
    }
    return ok({
      unitMass: missingMaterial ? 0 : props.value.mass,
      area: props.value.area,
      volume: props.value.volume,
      centroid: props.value.centroid,
      hasPart: true,
    });
  }

  const mesh = geometry.sheet;
  const faces = mesh.faces();
  const area = facesArea(mesh, faces);
  const centroid = sheetCentroid(mesh, faces, area);
  return ok({
    unitMass: missingMaterial ? 0 : area * geometry.gauge * (item.material?.density as number),
    area,
    ...(centroid === undefined ? {} : { centroid }),
    hasPart: true,
  });
}

function cycleNodes(
  nodes: readonly Node[],
  byId: ReadonlyMap<string, Node>,
  issues: Issue<BomCode>[],
): Set<string> {
  const done = new Set<string>();
  const cyclic = new Set<string>();
  for (const node of [...nodes].sort((a, b) =>
    a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0,
  )) {
    if (done.has(node.item.id)) continue;
    const path: string[] = [];
    const position = new Map<string, number>();
    let id: string | undefined = node.item.id;
    while (id !== undefined && !done.has(id)) {
      const at = position.get(id);
      if (at !== undefined) {
        const cycle = path.slice(at);
        for (const member of cycle) cyclic.add(member);
        cycle.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        issues.push({ code: 'bom-cycle', severity: 'error', detail: { ids: cycle } });
        break;
      }
      position.set(id, path.length);
      path.push(id);
      const current = byId.get(id);
      const parent = current?.item.parent;
      id = parent !== undefined && byId.has(parent) ? parent : undefined;
    }
    for (const member of path) done.add(member);
  }
  return cyclic;
}

function breakdown(
  nodes: readonly Node[],
  measures: ReadonlyMap<string, GeometryMeasure>,
  counts: ReadonlyMap<string, number>,
  field: 'material' | 'process',
  totalMass: number,
): { readonly name: string; readonly mass: number; readonly share: number }[] {
  const masses = new Map<string, number>();
  for (const node of [...nodes].sort((a, b) =>
    a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0,
  )) {
    const measure = measures.get(node.item.id) as GeometryMeasure;
    const mass = measure.unitMass * (counts.get(node.item.id) as number);
    if (!(mass > 0)) continue;
    const value = field === 'material' ? node.item.material?.name : node.item.process;
    const name = value ?? '(none)';
    masses.set(name, (masses.get(name) ?? 0) + mass);
  }
  return [...masses]
    .map(([name, mass]) => ({ name, mass, share: totalMass > 0 ? mass / totalMass : 0 }))
    .sort((a, b) => b.mass - a.mass || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Build a deterministic bill of materials with mass, quantity and centroid roll-up. */
export function bom(items: readonly BomItem[]): Result<BomReport, ModelingError> {
  const checked = validate(items);
  if (!checked.ok) return checked;

  const issues: Issue<BomCode>[] = [];
  const byId = new Map<string, Node>();
  const nodes: Node[] = [];
  for (const [index, item] of items.entries()) {
    if (byId.has(item.id)) {
      issues.push({ code: 'bom-duplicate-id', severity: 'error', detail: { id: item.id, index } });
      continue;
    }
    const parent = item.parent;
    const node: Node = {
      item,
      index,
      quantity: item.quantity ?? 1,
      ...(parent === undefined ? {} : { parent }),
    };
    byId.set(item.id, node);
    nodes.push(node);
  }

  for (const node of nodes) {
    if (node.parent !== undefined && !byId.has(node.parent)) {
      issues.push({
        code: 'bom-unknown-parent',
        severity: 'error',
        detail: { id: node.item.id, parent: node.parent },
      });
    }
  }
  const cyclic = cycleNodes(nodes, byId, issues);
  const effectiveParent = (node: Node): string | undefined => {
    const parent = node.parent;
    return parent !== undefined && byId.has(parent) && !cyclic.has(parent) ? parent : undefined;
  };
  const children = new Map<string, Node[]>();
  const roots: Node[] = [];
  for (const node of nodes) {
    if (cyclic.has(node.item.id)) continue;
    const parent = effectiveParent(node);
    if (parent === undefined) roots.push(node);
    else {
      const siblings = children.get(parent);
      if (siblings === undefined) children.set(parent, [node]);
      else siblings.push(node);
    }
  }

  const measures = new Map<string, GeometryMeasure>();
  for (const node of nodes) {
    if (cyclic.has(node.item.id)) continue;
    const measured = measureGeometry(node, issues);
    if (!measured.ok) return measured;
    measures.set(node.item.id, measured.value);
  }

  const ordered: { readonly node: Node; readonly depth: number }[] = [];
  const counts = new Map<string, number>();
  const visit = (node: Node, depth: number, count: number): void => {
    ordered.push({ node, depth });
    counts.set(node.item.id, count);
    for (const child of children.get(node.item.id) ?? []) {
      visit(child, depth + 1, count * child.quantity);
    }
  };
  for (const root of roots) visit(root, 0, root.quantity);

  const aggregationChildren = new Map(
    [...children].map(([id, siblings]) => [
      id,
      [...siblings].sort((a, b) => (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0)),
    ]),
  );
  const rollups = new Map<string, Rollup>();
  for (let i = ordered.length - 1; i >= 0; i--) {
    const node = (ordered[i] as (typeof ordered)[number]).node;
    const measure = measures.get(node.item.id) as GeometryMeasure;
    let mass = measure.unitMass;
    let hasParts = measure.hasPart;
    let complete = !measure.hasPart || measure.centroid !== undefined;
    const weighted: Tuple3 = [0, 0, 0];
    if (measure.centroid !== undefined) {
      for (let axis = 0; axis < 3; axis++) {
        weighted[axis] = measure.unitMass * (measure.centroid[axis] as number);
      }
    }
    for (const child of aggregationChildren.get(node.item.id) ?? []) {
      const childRollup = rollups.get(child.item.id) as Rollup;
      const childMass = childRollup.mass * child.quantity;
      mass += childMass;
      if (!childRollup.hasParts) continue;
      hasParts = true;
      if (childRollup.centroid === undefined) {
        complete = false;
      } else {
        for (let axis = 0; axis < 3; axis++) {
          weighted[axis] =
            (weighted[axis] as number) + childMass * (childRollup.centroid[axis] as number);
        }
      }
    }
    const centroid =
      complete && hasParts && mass > 0
        ? ([weighted[0] / mass, weighted[1] / mass, weighted[2] / mass] as Tuple3)
        : undefined;
    rollups.set(node.item.id, { mass, ...(centroid === undefined ? {} : { centroid }), hasParts });
  }

  const rows: BomRow[] = ordered.map(({ node, depth }) => {
    const item = node.item;
    const measure = measures.get(item.id) as GeometryMeasure;
    const rollup = rollups.get(item.id) as Rollup;
    const parent = effectiveParent(node);
    return {
      id: item.id,
      name: item.name ?? item.id,
      ...(parent === undefined ? {} : { parent }),
      depth,
      quantity: node.quantity,
      count: counts.get(item.id) as number,
      ...(item.material === undefined ? {} : { material: item.material.name }),
      ...(item.process === undefined ? {} : { process: item.process }),
      ...(item.geometry !== undefined && 'sheet' in item.geometry
        ? { gauge: item.geometry.gauge }
        : {}),
      ...(measure.area === undefined ? {} : { area: measure.area }),
      ...(measure.volume === undefined ? {} : { volume: measure.volume }),
      unitMass: measure.unitMass,
      mass: rollup.mass,
      ...(rollup.centroid === undefined ? {} : { centroid: rollup.centroid }),
    };
  });

  let totalMass = 0;
  for (const root of [...roots].sort((a, b) =>
    a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0,
  )) {
    totalMass += (rollups.get(root.item.id) as Rollup).mass * root.quantity;
  }
  const parts = ordered.reduce((sum, entry) => {
    if (entry.node.item.geometry === undefined) return sum;
    return sum + (counts.get(entry.node.item.id) as number);
  }, 0);
  const surviving = ordered.map((entry) => entry.node);
  issues.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return ok({
    pass: issues.length === 0,
    rows,
    totals: {
      mass: totalMass,
      parts,
      byMaterial: breakdown(surviving, measures, counts, 'material', totalMass),
      byProcess: breakdown(surviving, measures, counts, 'process', totalMass),
    },
    issues,
  });
}

/** Render a BOM report as a header row and fixed-order string cells. */
export function bomTable(report: BomReport): string[][] {
  return [
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
    ...report.rows.map((row) => [
      row.id,
      row.name,
      row.parent ?? '-',
      String(row.depth),
      String(row.quantity),
      String(row.count),
      row.material ?? '-',
      row.process ?? '-',
      row.gauge === undefined ? '-' : (row.gauge * 1000).toFixed(2),
      row.area === undefined ? '-' : String(row.area),
      row.volume === undefined ? '-' : String(row.volume),
      row.unitMass.toFixed(3),
      row.mass.toFixed(3),
      row.centroid === undefined ? '-' : row.centroid.join(' '),
    ]),
  ];
}
