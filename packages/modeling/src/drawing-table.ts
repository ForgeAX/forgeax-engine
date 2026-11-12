import { err, ok, type Result } from '@forgeax/engine-types';
import { type DrawnTable, type ExplodedPart, TABLE_CELL_LIMIT } from './drawing';
import { type ModelingError, modelingError } from './errors';
import type { JointSpec, Range } from './rig';
import { DTS_ZONES, type DtsRow, type ShutLineLimits, type ShutLineReport } from './shut-lines';

/** Where a table's rows come from: DTS rows (with their gauge report), joints, or exploded parts. */
export type TableSource =
  | { readonly kind: 'dts'; readonly rows: readonly DtsRow[]; readonly report?: ShutLineReport }
  | { readonly kind: 'joints'; readonly joints: readonly JointSpec[] }
  | { readonly kind: 'bom'; readonly parts: readonly ExplodedPart[] };

const mm = (m: number): string =>
  Number.isFinite(m) ? (Math.round(m * 1e5) / 100).toFixed(2) : '-';

const span = (r: Range, unit: string, scale: number): string =>
  `${r[0] * scale}..${r[1] * scale} ${unit}`;

function limitsOf(row: DtsRow): ShutLineLimits {
  return { ...DTS_ZONES[row.zone ?? 'A'], ...row.limits };
}

function dtsTable(
  source: Extract<TableSource, { kind: 'dts' }>,
): Pick<DrawnTable, 'columns' | 'rows'> {
  const status = new Map((source.report?.rows ?? []).map((r) => [r.id, r.status]));
  const columns = [
    'row',
    'parts',
    'zone',
    'gap mm',
    'flush mm',
    'parallel mm',
    'symmetry mm',
    'visual mm',
  ];
  if (source.report !== undefined) columns.push('status');
  const rows = source.rows.map((row) => {
    const l = limitsOf(row);
    const cells: (string | number)[] = [
      row.id,
      `${row.parts[0]} / ${row.parts[1]}`,
      row.zone ?? 'A',
      `${mm(l.gap[0])}..${mm(l.gap[1])}`,
      mm(l.flush),
      mm(l.parallelism),
      mm(l.symmetry),
      mm(l.visualGap),
    ];
    if (source.report !== undefined) cells.push(status.get(row.id) ?? 'missing');
    return cells;
  });
  return { columns, rows };
}

function jointLimits(joint: JointSpec): string {
  const limits = joint.limits;
  if (limits === undefined) return '-';
  const kind = joint.kind ?? 'fixed';
  if (Array.isArray(limits)) {
    const r = limits as Range;
    return kind === 'prismatic' ? span(r, 'mm', 1000) : span(r, 'deg', 1);
  }
  const per = limits as Readonly<Partial<Record<'x' | 'y' | 'z', Range>>>;
  const parts = (['x', 'y', 'z'] as const).flatMap((axis) => {
    const r = per[axis];
    return r === undefined ? [] : [`${axis} ${r[0]}..${r[1]}`];
  });
  return parts.length === 0 ? '-' : `${parts.join('; ')} deg`;
}

function jointAxis(joint: JointSpec): string {
  if (joint.axis === undefined) return '-';
  return typeof joint.axis === 'string' ? joint.axis : joint.axis.join(' ');
}

function jointTable(
  source: Extract<TableSource, { kind: 'joints' }>,
): Pick<DrawnTable, 'columns' | 'rows'> {
  return {
    columns: ['joint', 'parent', 'kind', 'axis', 'limits'],
    rows: source.joints.map((j) => [
      j.name,
      j.parent ?? '-',
      j.kind ?? 'fixed',
      jointAxis(j),
      jointLimits(j),
    ]),
  };
}

/** Parts by explode step, then name: the item numbers of a bill of materials. @internal */
export function rankParts(parts: readonly ExplodedPart[]): ExplodedPart[] {
  return [...parts].sort(
    (a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

function bomTable(
  source: Extract<TableSource, { kind: 'bom' }>,
): Pick<DrawnTable, 'columns' | 'rows'> {
  return {
    columns: ['item', 'part', 'order', 'faces', 'offset'],
    rows: rankParts(source.parts).map((p, i) => [
      i + 1,
      p.name,
      p.order,
      p.faces,
      `${p.offset.map((c) => Math.round(c * 1e5) / 100).join(' ')} mm`,
    ]),
  };
}

/**
 * A table item derived from its owner: DTS rows (zone defaults merged with row limits, and the
 * gauge status when a report is given), joints in the order given (parents first), or the bill
 * of exploded parts. Rows are derived, never copied, so a changed zone or limit changes the cell.
 */
export function drawingTable(
  id: string,
  view: string,
  source: TableSource,
): Result<DrawnTable, ModelingError> {
  let content: Pick<DrawnTable, 'columns' | 'rows'>;
  let count: number;
  switch (source?.kind) {
    case 'dts':
      count = source.rows.length;
      if (count === 0) break;
      content = dtsTable(source);
      return finish(id, view, content);
    case 'joints':
      count = source.joints.length;
      if (count === 0) break;
      content = jointTable(source);
      return finish(id, view, content);
    case 'bom':
      count = source.parts.length;
      if (count === 0) break;
      content = bomTable(source);
      return finish(id, view, content);
    default:
      return err(
        modelingError('model-invalid-argument', "a table source is 'dts', 'joints' or 'bom'", {
          kind: (source as { kind?: unknown } | undefined)?.kind,
        }),
      );
  }
  return err(
    modelingError('model-invalid-argument', `a ${source.kind} table has at least one row`, { id }),
  );
}

function finish(
  id: string,
  view: string,
  content: Pick<DrawnTable, 'columns' | 'rows'>,
): Result<DrawnTable, ModelingError> {
  const cells = (content.rows.length + 1) * content.columns.length;
  if (cells > TABLE_CELL_LIMIT) {
    return err(
      modelingError(
        'model-work-budget',
        `a drawing holds at most ${TABLE_CELL_LIMIT} table cells`,
        {
          cells,
        },
      ),
    );
  }
  return ok({ id, view, role: 'guide', kind: 'table', ...content });
}
