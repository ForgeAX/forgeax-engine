import { fileURLToPath } from 'node:url';
import { type EditMesh, type Selector, sel } from '@forgeax/engine-modeling';
import {
  createModelingTools,
  MODEL_SYNTHESIZE_REPORT,
  type ModelSynthesizeReport,
} from '@forgeax/engine-modeling/tools';
import { describe, expect, it } from 'vitest';
import { buildBracket, buildRim } from './fixtures/synth-parts.ts';

/** `model.synthesize` through the capture Worker and Pack loader on kernel-owned ranged Packs. */
const root = fileURLToPath(new URL('../../', import.meta.url));

function tool(id: string) {
  const contribution = createModelingTools({ projectRoot: root }).find(
    (t) => t.descriptor.id === id,
  );
  if (contribution === undefined) throw new Error(id);
  return (args: Record<string, unknown>) =>
    contribution.execute(args as never, {} as never) as Promise<{
      ok: boolean;
      value?: unknown;
      error?: { code: string; expected?: string };
    }>;
}

const synthesize = async (args: Record<string, unknown>) => {
  const out = await tool('model.synthesize')(args);
  expect(out.error).toBeUndefined();
  const report = out.value as ModelSynthesizeReport;
  expect(report.schema).toBe(MODEL_SYNTHESIZE_REPORT);
  return report;
};

/**
 * A sound selector: every rebuild that ran verified J = 1. A rebuild that timed out under load
 * proves nothing, so the label is then `unchecked` (never `unstable`) with the error in its check.
 */
function expectStable(report: ModelSynthesizeReport) {
  const ran = report.checks.filter((c) => c.error === undefined);
  expect(ran.every((c) => c.jaccard === 1)).toBe(true);
  expect(report.stability).toBe(ran.length === report.checks.length ? 'stable' : 'unchecked');
}

/** Pack builds are deterministic, so in-process ids equal the captured session ids. */
function ids(mesh: EditMesh, expression: string): number[] {
  return (new Function('sel', `return (${expression});`)(sel) as Selector<'face'>).evaluate(mesh);
}

const BRACKET = 'src/__tests__/fixtures/synth-bracket.pack.ts';
const RIM = 'src/__tests__/fixtures/synth-rim.pack.ts';

describe('model.synthesize', () => {
  it('one side of the bracket is a stable tag-and-direction selector', {
    timeout: 180000,
  }, async () => {
    const faces = ids(buildBracket().editMesh, "sel.tag('bracket').and(sel.facing('-x', 5))");
    const report = await synthesize({ source: BRACKET, pick: { faces } });
    expect(report).toMatchObject({ jaccard: 1, fallback: false, picked: faces.length });
    expect(report.checks).toHaveLength(6);
    expectStable(report);
    expect(report.highlight.topology).toBe('triangle-list');
    expect(report.highlight.positions.length).toBeGreaterThan(0);
  });

  it('picks by ray, a stable role union and an unstable positional fallback', {
    timeout: 180000,
  }, async () => {
    const mesh = buildBracket().editMesh;
    const boss = await synthesize({
      source: BRACKET,
      pick: { faces: ids(mesh, "sel.createdBy('boss', 'top').grow(1)") },
    });
    expect(boss).toMatchObject({ jaccard: 1, fallback: false });
    expect(boss.checks).toHaveLength(6);
    expectStable(boss);

    // Three cells of the segmented foot top: nothing but their position names them.
    const patch = await synthesize({
      source: BRACKET,
      pick: { faces: ids(mesh, 'sel.near([0.115, 0.028, 0.04], 3)') },
    });
    expect(patch).toMatchObject({ jaccard: 1, fallback: true, stability: 'unstable' });
    expect(patch.checks.some((c) => c.jaccard < 1)).toBe(true);

    // A click: the ray along +x hits the boss top (the boss stands on the -x face).
    const top = ids(mesh, "sel.createdBy('boss', 'top')");
    const selected = await tool('model.select')({
      source: BRACKET,
      selector: "sel.createdBy('boss', 'top')",
      highlight: true,
    });
    const bounds = (
      selected.value as { selected: { bounds: number[]; highlight: { positions: number[] } } }
    ).selected;
    expect(bounds.highlight.positions.length).toBeGreaterThan(0);
    const [x0, y0, z0, , y1, z1] = bounds.bounds as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const ray = { origin: [x0 - 1, (y0 + y1) / 2, (z0 + z1) / 2], direction: [1, 0, 0] };
    const clicked = await synthesize({ source: BRACKET, pick: { rays: [ray] }, stability: false });
    expect(clicked.pickedIds).toEqual(top);
    expect(clicked).toMatchObject({
      expression: "sel.createdBy('boss', 'top')",
      stability: 'unchecked',
    });
  });

  it('all windows stay selected across spoke counts, one window does not', {
    timeout: 600000,
  }, async () => {
    const mesh = buildRim().editMesh;
    const all = await synthesize({
      source: RIM,
      pick: { faces: ids(mesh, "sel.createdBy('windows', 'cutB')") },
      parameters: ['spokes'],
    });
    expect(all.jaccard).toBe(1);
    expectStable(all);
    for (const c of all.checks.filter((k) => k.error === undefined)) {
      expect(c.matched).toBe((all.picked / 5) * c.value);
    }
    const one = await synthesize({
      source: RIM,
      pick: { faces: ids(mesh, "sel.tag('window-array:2').and(sel.createdBy('windows', 'cutB'))") },
      parameters: ['spokes'],
    });
    expect(one).toMatchObject({
      expression: "sel.tag('window-array:2')",
      jaccard: 1,
      stability: 'unstable',
    });
    // With ten spokes copy 2 sits at 72 degrees instead of 144: the picked window is another copy.
    expect(one.checks.find((c) => c.value === 10)?.jaccard).toBeLessThan(1);

    // A box select (hidden faces too) around lug pocket 0 on the 112 mm pitch circle, seen from the top.
    const box = {
      center: [0, 0.1, 0.056],
      right: [1, 0, 0],
      up: [0, 0, -1],
      halfWidth: 0.013,
      halfHeight: 0.013,
      direction: [0, -1, 0],
      visible: false,
    };
    const lug = await synthesize({ source: RIM, pick: { boxes: [box] }, parameters: ['diameter'] });
    expect(lug).toMatchObject({
      expression: "sel.tag('seat-array:0').or(sel.tag('lug-array:0'))",
      jaccard: 1,
      fallback: false,
    });
    expectStable(lug);
  });

  it('reports empty picks and invalid sources as structured failures', {
    timeout: 60000,
  }, async () => {
    const empty = await tool('model.synthesize')({
      source: BRACKET,
      pick: { rays: [{ origin: [5, 5, 5], direction: [1, 0, 0] }] },
    });
    expect(empty).toMatchObject({ ok: false, error: { code: 'model-selection-empty' } });
    const outside = await tool('model.synthesize')({
      source: '../x.pack.ts',
      pick: { faces: [0] },
    });
    expect(outside).toMatchObject({ ok: false, error: { code: 'tool-invalid-args' } });
  });
});
