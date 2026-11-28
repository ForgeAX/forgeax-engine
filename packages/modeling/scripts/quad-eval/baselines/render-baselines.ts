// Contact sheet per case comparing the baselines: quad network on the top row, scaled-Jacobian heat below.
// The kit imports extensionless kernel sources, so run it through vitest (the render test):
//   QB_RENDER_OUT=<dir> npx vitest run scripts/quad-eval/baselines/__tests__/render.test.ts
// Output: <out>/<case>-sheet.png plus per-tool PNGs under <out>/<case>/.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contactSheet,
  createImage,
  type Image,
  renderShape,
  type SheetCell,
  toPng,
} from '../../../examples/brep-kit/index.ts';
import { parseMesh } from '../mesh.ts';
import { evaluate } from '../metrics.ts';
import { BASELINE_CASES, TOOL_NAMES, TOOLS } from './config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CELL = 360;

export function renderBaselines(out: string, only?: string): string[] {
  mkdirSync(out, { recursive: true });
  const sheets: string[] = [];
  for (const c of BASELINE_CASES) {
    if (only !== undefined && c.id !== only) continue;
    const network: SheetCell[] = [];
    const jac: SheetCell[] = [];
    for (const tool of TOOLS) {
      const file = join(here, 'results', tool, `${c.id}.json`);
      const blank: Image = createImage(CELL, CELL, [30, 32, 40]);
      if (!existsSync(file)) {
        const why = `${TOOL_NAMES[tool]}: baseline not available`;
        network.push({ image: blank, caption: why });
        jac.push({ image: blank, caption: why });
        continue;
      }
      const parsed = parseMesh(JSON.parse(readFileSync(file, 'utf8')));
      if (!parsed.ok) throw new Error(`${file}: ${parsed.issue.code}`);
      const ev = evaluate(parsed.mesh);
      const result = renderShape(
        {
          positions: parsed.mesh.positions.map(
            (p) => [p[0], p[1], p[2]] as [number, number, number],
          ),
          faces: parsed.mesh.faces,
        },
        {
          modes: ['network', 'jacobian'],
          views: ['iso'],
          size: CELL,
          label: false,
          legend: 'first',
        },
      );
      if (!result.ok) throw new Error(`${c.id}/${tool}: render failed ${result.error.code}`);
      const net = result.value.views.find((v) => v.mode === 'network');
      const jc = result.value.views.find((v) => v.mode === 'jacobian');
      if (net === undefined || jc === undefined) throw new Error('missing view');
      const caption = `${TOOL_NAMES[tool]} ${parsed.mesh.faces.length}f, SJ min ${ev.scaledJacobian.min.toFixed(2)}, ${ev.valence.singularities.count} singular, ${ev.inverted.count} inverted`;
      network.push({ image: net.image, caption });
      jac.push({
        image: jc.image,
        caption: `${TOOL_NAMES[tool]} scaled Jacobian heat (red low, blue high)`,
      });
      const dir = join(out, c.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${tool}-network.png`), toPng(net.image));
      writeFileSync(join(dir, `${tool}-jacobian.png`), toPng(jc.image));
    }
    contactSheet([...network, ...jac], {
      columns: TOOLS.length,
      cell: CELL,
      title: `${c.id}: Instant Meshes | QuadriFlow | QuadWild (target ${c.targetFaces} faces)`,
      path: join(out, `${c.id}-sheet.png`),
    });
    sheets.push(join(out, `${c.id}-sheet.png`));
  }
  return sheets;
}
