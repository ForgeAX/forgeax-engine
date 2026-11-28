import { contactSheet, renderShape, type SheetCell } from '../brep-kit/index.ts';
import { buildBracket } from './bracket.ts';

export interface BracketRender {
  readonly faceCounts: readonly number[];
  readonly volume: number;
  readonly sheet: string;
}

export function renderBracket(outDir: string, size = 640): BracketRender {
  const bracket = buildBracket();
  const cells: SheetCell[] = [];
  for (const [name, shape] of [
    ['before', bracket.raw],
    ['filled', bracket.filled],
    ['split', bracket.split],
    ['simplified', bracket.simplified],
  ] as const) {
    const r = renderShape(shape, {
      outDir,
      name: `${name}-`,
      size,
      modes: ['shaded', 'features', 'iso'],
      views: ['iso', 'front', 'top'],
      colorBy: 'face',
      silhouette: false,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    for (const v of r.value.views)
      cells.push({ image: v.image, caption: `${name} ${v.mode} ${v.view}` });
  }
  const sheet = `${outDir}/bracket-sheet.png`;
  contactSheet(cells, {
    columns: 3,
    cell: 320,
    title: 'B-rep angle bracket edits: remove a hole, split an end face, simplify',
    path: sheet,
  });
  return { faceCounts: bracket.faceCounts, volume: bracket.volume, sheet };
}
