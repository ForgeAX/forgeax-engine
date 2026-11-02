import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Model, model, regen, Selector, sel } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  createCaseRenderer,
  frameModel,
  frameSnapshot,
  highlighted,
  historyStep,
  stateMesh,
  touched,
} from '../../case/render';
import { buildFeatureBracket, FEATURE_BRACKET_SETS, type FeatureBracketParameters } from '../body';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the finished bracket;
 * with FORGEAX_CASE_OUT set it writes the case output directory: one image per
 * recorded step, the three parameter sets as a 2x2 sheet with the deliberate red sample,
 * the green and red regen reports, history.json and the sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../body.ts', import.meta.url));
const DIRECTION = [0.62, 0.6, 0.5];
const SLOTS = {
  Default: [0.6, 0.62, 0.66],
  machined: [0.82, 0.78, 0.68],
  highlight: [0.95, 0.2, 0.55],
} as const;
const RED_FACE = 20;

function turned(m: Model): Model {
  const copy = model();
  copy.append(m.snapshot());
  copy.rotate(sel.all(), 'y', 180);
  return copy;
}

function withIndexPick(p: FeatureBracketParameters): Model {
  const m = buildFeatureBracket(p);
  const byIndex = new Selector('face', `faceId(${RED_FACE})`, (mesh) =>
    mesh.faces().filter((f) => f === RED_FACE),
  );
  m.extrude(byIndex.one(), { distance: 0.001, region: 'merged', label: 'by-index' });
  return m;
}

function withFacingSwap(p: FeatureBracketParameters): Model {
  const m = buildFeatureBracket(p);
  const flip = p === FEATURE_BRACKET_SETS[1];
  const wall = new Selector('face', 'pocket-wall', (mesh) =>
    sel
      .createdBy('pocket-cut', 'side')
      .and(sel.facing(flip ? '-x' : '+x'))
      .evaluate(mesh),
  );
  m.extrude(wall.one(), { distance: 0.001, region: 'merged', label: 'swapped' });
  return m;
}

function sheet(images: readonly PNG[]): PNG {
  const out = new PNG({ width: WIDTH * 2, height: HEIGHT * Math.ceil(images.length / 2) });
  for (const [i, image] of images.entries()) {
    const ox = (i % 2) * WIDTH;
    const oy = Math.floor(i / 2) * HEIGHT;
    for (let y = 0; y < HEIGHT; y++) {
      out.data.set(
        image.data.subarray(y * image.width * 4, (y * image.width + WIDTH) * 4),
        ((oy + y) * out.width + ox) * 4,
      );
    }
  }
  return out;
}

describe('C-123 case evidence on the real renderer (Dawn)', () => {
  it('renders the steps, the three parameter sets and the red sample', {
    timeout: 900000,
  }, async () => {
    const recording = recordingSessions();
    const base = buildFeatureBracket(FEATURE_BRACKET_SETS[0], recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const green = regen(buildFeatureBracket, FEATURE_BRACKET_SETS);
    const red = regen(withIndexPick, FEATURE_BRACKET_SETS);
    expect(green.ok && green.value.pass).toBe(true);
    expect(red.ok && red.value.pass).toBe(false);
    const swap = regen(withFacingSwap, FEATURE_BRACKET_SETS);
    expect(swap.ok && swap.value.findings.map((f) => f.reason)).toEqual(['selector-signature']);
    const main = frameModel(turned(base), DIRECTION);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOTS,
      metallic: ['machined'],
      view: main,
    });
    try {
      const shown = async (m: Model, extra?: Parameters<typeof highlighted>[1]) => {
        const t = turned(m);
        const view = frameModel(t, DIRECTION);
        r.aim(view);
        const mesh = extra === undefined ? t.toMesh({ normals: { mode: 'weighted' } }) : undefined;
        if (mesh !== undefined && !mesh.ok) throw mesh.error;
        return r.render(mesh === undefined ? highlighted(t, extra as never) : mesh.value.mesh);
      };
      const setImages: PNG[] = [];
      for (const p of FEATURE_BRACKET_SETS) setImages.push(await shown(buildFeatureBracket(p)));
      const redModel = withIndexPick(FEATURE_BRACKET_SETS[1] as FeatureBracketParameters);
      const redSelector = sel.createdBy('by-index');
      setImages.push(await shown(redModel, redSelector));
      setImages.push(
        await shown(
          withFacingSwap(FEATURE_BRACKET_SETS[1] as FeatureBracketParameters),
          sel.createdBy('swapped'),
        ),
      );
      for (const image of setImages)
        expect(r.covered(image)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      mkdirSync(join(OUT, 'source'), { recursive: true });
      const stepImages: string[] = [];
      for (const [i, step] of steps.entries()) {
        r.aim(frameSnapshot(step.snapshot, DIRECTION));
        const name = `step-${String(i + 1).padStart(2, '0')}.png`;
        writeFileSync(
          join(OUT, name),
          PNG.sync.write(await r.render(stateMesh(step.snapshot, touched(step)))),
        );
        stepImages.push(name);
      }
      writeFileSync(join(OUT, 'view-V-sets.png'), PNG.sync.write(sheet(setImages)));
      for (const [i, image] of setImages.entries()) {
        writeFileSync(
          join(OUT, `view-V-${i < 3 ? `set-${i + 1}` : i === 3 ? 'red' : 'swap'}.png`),
          PNG.sync.write(image),
        );
      }
      writeFileSync(
        join(OUT, 'regen-green.json'),
        `${JSON.stringify(green.ok ? green.value : green.error, null, 2)}\n`,
      );
      writeFileSync(
        join(OUT, 'regen-red.json'),
        `${JSON.stringify(red.ok ? red.value : red.error, null, 2)}\n`,
      );
      writeFileSync(
        join(OUT, 'regen-red-swap.json'),
        `${JSON.stringify(swap.ok ? swap.value : swap.error, null, 2)}\n`,
      );
      for (const file of [
        'body.ts',
        '__tests__/feature-bracket.case.dawn.test.ts',
        '__tests__/feature-bracket.unit.test.ts',
      ]) {
        copyFileSync(
          fileURLToPath(new URL(`../${file}`, import.meta.url)),
          join(OUT, 'source', file.split('/').at(-1) as string),
        );
      }
      const validate = FEATURE_BRACKET_SETS.map((p) =>
        buildFeatureBracket(p).validate({ minThickness: 0.002 }),
      );
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validate, null, 2)}\n`);
      const inspection = base.inspect();
      const history = {
        case: 'C-123',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/feature-bracket/body.ts',
        },
        parameters: FEATURE_BRACKET_SETS[0],
        parameterSets: FEATURE_BRACKET_SETS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step is framed on its own state from one fixed direction; the sheet frames each set on its own bounds, turned 180 degrees about Y so the boss and hole face the camera',
        },
        highlight: 'each step image shows the faces the step touched in magenta',
        steps: steps.map((step, i) => ({
          ...historyStep(step, i + 1),
          selectors: step.entry.selectors ?? [],
          image: stepImages[i],
        })),
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          labels: inspection.labels,
          validate: 'validate.json',
        },
        regen: {
          green: { report: 'regen-green.json', pass: green.ok && green.value.pass },
          red: {
            report: 'regen-red.json',
            pass: red.ok && red.value.pass,
            firstFinding: red.ok ? red.value.findings[0] : undefined,
          },
          redSwap: {
            report: 'regen-red-swap.json',
            pass: swap.ok && swap.value.pass,
            firstFinding: swap.ok ? swap.value.findings[0] : undefined,
          },
        },
        views: [
          { view: 'V-sets', image: 'view-V-sets.png' },
          ...[1, 2, 3].map((n) => ({ view: `V-set-${n}`, image: `view-V-set-${n}.png` })),
          { view: 'V-red', image: 'view-V-red.png' },
          { view: 'V-swap', image: 'view-V-swap.png' },
        ],
        legend: {
          'V-sets':
            'top-left, top-right, bottom-left: parameter sets 1-3 (regen green); bottom-right: set 2 with a deliberately index-based pick on step 12 (highlighted), reported red by regen; V-swap: set 2 where a stable-text pick swaps from the +x to the -x pocket wall (highlighted), reported red by its geometric signature',
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
