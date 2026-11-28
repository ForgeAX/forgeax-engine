import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Continuity,
  type ContinuityReport,
  measureContinuity,
} from '../../src/brep/continuity.ts';
import { tessellate } from '../../src/brep/tessellate.ts';
import type { Shape } from '../../src/brep/types.ts';
import { must } from '../brep-heal/damage.ts';
import {
  classifyEdges,
  contactSheet,
  drawLegend,
  type Image,
  type LegendEntry,
  mergeScenes,
  renderScene,
  type Scene,
  type SceneLine,
  toPng,
  type ViewSpec,
} from '../brep-kit/index.ts';
import { meshSurface } from '../brep-kit/mesh-scene.ts';
import { allCases, type ContinuityCase } from './cases.ts';

type RGB = readonly [number, number, number];

export const GRADE_COLOR: Record<Continuity, RGB> = {
  open: [255, 60, 60],
  G0: [255, 150, 40],
  G1: [70, 190, 255],
  G2: [90, 235, 130],
};
const SEAM: RGB = [110, 116, 128];
const GRADE_NAME: Record<Continuity, string> = {
  open: 'open (faces do not meet)',
  G0: 'G0 crease',
  G1: 'G1 tangent',
  G2: 'G2 curvature continuous',
};

/** One coloured line per measured edge; seam edges (one face on both sides) stay grey and thin. */
export function continuityLines(shape: Shape, report: ContinuityReport): SceneLine[] {
  const points = new Map(classifyEdges(shape).map((c) => [c.edge, c.points]));
  const lines: SceneLine[] = [];
  for (const e of report.edges) {
    const p = points.get(e.edge);
    if (p === undefined) continue;
    lines.push(
      e.seam
        ? { points: p, color: SEAM, width: 1.2, dash: [3, 3], bias: 0.6 }
        : { points: p, color: GRADE_COLOR[e.grade], width: 3.2, bias: 2, xray: e.grade === 'open' },
    );
  }
  return lines;
}

function legend(image: Image, report: ContinuityReport): void {
  const entries: LegendEntry[] = [];
  for (const g of ['G2', 'G1', 'G0', 'open'] as const) {
    const n = report.edges.filter((e) => !e.seam && e.grade === g).length;
    if (n > 0) entries.push({ label: `${GRADE_NAME[g]} ${n}`, color: GRADE_COLOR[g] });
  }
  const seams = report.edges.filter((e) => e.seam).length;
  if (seams > 0) entries.push({ label: `seam ${seams}`, color: SEAM, style: 'dash' });
  drawLegend(image, 8, 8, 'edge continuity', entries, 1);
}

export interface ContinuityRender {
  readonly name: string;
  readonly report: ContinuityReport;
  /** Edge counts per grade, seams excluded. */
  readonly counts: Readonly<Record<Continuity, number>>;
  readonly sheet: string;
}

const VIEWS: readonly ViewSpec[] = ['iso', 'iso-back'];

export function renderContinuity(c: ContinuityCase, outDir: string, size = 560): ContinuityRender {
  mkdirSync(outDir, { recursive: true });
  const parts = [c.shape, ...(c.extra ?? [])];
  const reports = parts.map((p) => must(measureContinuity(p)));
  const report: ContinuityReport = {
    edges: reports.flatMap((r) => r.edges),
    skipped: reports.flatMap((r) => r.skipped),
    counts: {
      open: reports.reduce((n, r) => n + r.counts.open, 0),
      G0: reports.reduce((n, r) => n + r.counts.G0, 0),
      G1: reports.reduce((n, r) => n + r.counts.G1, 0),
      G2: reports.reduce((n, r) => n + r.counts.G2, 0),
    },
  };
  const scene: Scene = mergeScenes(
    ...parts.map((p, i) => ({
      tris: meshSurface(must(tessellate(p, { angle: Math.PI / 32 })), { dim: 0.38 }),
      lines: continuityLines(p, reports[i] as ContinuityReport),
      markers: [],
    })),
  );
  const cells: { image: Image; caption: string }[] = [];
  for (const view of VIEWS) {
    const image = renderScene(scene, view, { size });
    legend(image, report);
    const name = typeof view === 'string' ? view : view.name;
    writeFileSync(join(outDir, `${c.name}-${name}.png`), toPng(image));
    cells.push({ image, caption: `${c.name} ${name}` });
  }
  const counts: Record<Continuity, number> = { open: 0, G0: 0, G1: 0, G2: 0 };
  for (const e of report.edges) if (!e.seam) counts[e.grade]++;
  const sheet = join(outDir, `${c.name}-sheet.png`);
  contactSheet(cells, { columns: 2, cell: size, title: `${c.name}: ${c.caption}`, path: sheet });
  return { name: c.name, report, counts, sheet };
}

export function renderAll(outDir: string, size = 560): ContinuityRender[] {
  return allCases().map((c) => renderContinuity(c, outDir, size));
}
