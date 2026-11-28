import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tessellate } from '../../src/brep/tessellate.ts';
import { validate } from '../../src/brep/validate.ts';
import { must } from '../brep-heal/damage.ts';
import {
  contactSheet,
  drawLegend,
  featureLines,
  type Image,
  type LegendEntry,
  type RGB,
  renderScene,
  toPng,
} from '../brep-kit/index.ts';
import { meshSurface } from '../brep-kit/mesh-scene.ts';
import { GAPS } from './gaps.ts';
import {
  gearboxCover,
  type PartFeature,
  pumpManifold,
  type StepRecord,
  type StressPart,
} from './parts.ts';

/** One colour per feature step, so a render shows which construction produced each solid. */
const STEP_COLORS: readonly RGB[] = [
  [150, 172, 205],
  [215, 160, 105],
  [120, 195, 150],
  [205, 130, 175],
  [205, 198, 105],
  [110, 185, 205],
  [190, 150, 120],
];

type Mode = 'shaded' | 'features';
const VIEWS = ['iso', 'front', 'top'] as const;

function colorOf(features: readonly PartFeature[]): RGB[] {
  const seen = new Map<string, RGB>();
  return features.map((f) => {
    if (!seen.has(f.id)) seen.set(f.id, STEP_COLORS[seen.size % STEP_COLORS.length] as RGB);
    return seen.get(f.id) as RGB;
  });
}

export function drawPart(
  part: StressPart,
  mode: Mode,
  view: (typeof VIEWS)[number],
  size = 640,
): Image {
  const colors = colorOf(part.features);
  const meshes = part.features.map((f) => must(tessellate(f.shape, { angle: Math.PI / 32 })));
  const scene = {
    tris: meshes.flatMap((m, i) =>
      meshSurface(m, { color: colors[i] as RGB, dim: mode === 'shaded' ? 1 : 0.4 }),
    ),
    lines: mode === 'features' ? part.features.flatMap((f) => featureLines(f.shape)) : [],
    markers: [],
  };
  const image = renderScene(scene, view, { size });
  const entries: LegendEntry[] = [];
  part.features.forEach((f, i) => {
    if (f.label !== '' && !entries.some((e) => e.label === `${f.id} ${f.label}`))
      entries.push({ label: `${f.id} ${f.label}`, color: colors[i] as RGB });
  });
  drawLegend(
    image,
    8,
    size - 16 - 17 * (entries.length + 1),
    `${part.name} ${mode} ${view}`,
    entries,
  );
  return image;
}

export interface StressReport {
  readonly parts: readonly {
    readonly name: string;
    readonly steps: readonly StepRecord[];
    readonly solids: readonly {
      readonly id: string;
      readonly label: string;
      readonly faces: number;
      readonly valid: boolean;
    }[];
  }[];
  readonly gaps: readonly {
    readonly id: string;
    readonly owner: string;
    readonly summary: string;
    readonly repro: string;
    readonly outcome: 'fail-close' | 'builds';
    readonly failure?: {
      readonly code: string;
      readonly expected: string;
      readonly detail: Readonly<Record<string, unknown>>;
    };
  }[];
}

export function buildAll(): StressPart[] {
  return [gearboxCover(), pumpManifold()];
}

export function makeReport(parts: readonly StressPart[]): StressReport {
  return {
    parts: parts.map((p) => ({
      name: p.name,
      steps: p.steps,
      solids: p.features.map((f) => ({
        id: f.id,
        label: f.label,
        faces: f.shape.faces.length,
        valid: validate(f.shape).ok,
      })),
    })),
    gaps: GAPS.map((g) => {
      const r = g.run();
      const base = { id: g.id, owner: g.owner, summary: g.summary, repro: g.repro };
      return r.ok
        ? { ...base, outcome: 'builds' as const }
        : {
            ...base,
            outcome: 'fail-close' as const,
            failure: {
              code: r.error.code,
              expected: r.error.expected,
              detail: (r.error.detail ?? {}) as Record<string, unknown>,
            },
          };
    }),
  };
}

export function renderStress(outDir: string, parts: readonly StressPart[], size = 640): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const part of parts) {
    const cells: { image: Image; caption: string }[] = [];
    for (const mode of ['shaded', 'features'] as const)
      for (const view of VIEWS) {
        const image = drawPart(part, mode, view, size);
        const path = join(outDir, `${part.name}-${mode}-${view}.png`);
        writeFileSync(path, toPng(image));
        written.push(path);
        cells.push({ image, caption: `${mode} ${view}` });
      }
    const sheet = contactSheet(cells, { columns: 3, cell: Math.min(size, 420), title: part.name });
    const path = join(outDir, `${part.name}-sheet.png`);
    writeFileSync(path, toPng(sheet));
    written.push(path);
  }
  return written;
}
