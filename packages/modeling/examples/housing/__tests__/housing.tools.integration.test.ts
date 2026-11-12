import { fileURLToPath } from 'node:url';
import type { MeshDiff } from '@forgeax/engine-modeling';
import { createModelingTools, MODEL_DIFF_REPORT } from '@forgeax/engine-modeling/tools';
import { operationCommandPath } from '@forgeax/engine-tool-runtime';
import { describe, expect, it } from 'vitest';

/** C-012 through the capture Worker and Pack loading that `forgeax model *` use. */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = 'examples/housing/housing.pack.ts';

function tool(id: string) {
  const contribution = createModelingTools({ projectRoot: root }).find(
    (t) => t.descriptor.id === id,
  );
  if (contribution === undefined) throw new Error(id);
  return (args: Record<string, unknown>) =>
    contribution.execute(args as never, {} as never) as Promise<{
      ok: boolean;
      value?: Record<string, unknown>;
      error?: { code: string; expected?: string };
    }>;
}

describe('C-012 through the real Pack loader', () => {
  it('model.diff derives its CLI path and compares two parameter sets', { timeout: 120000 }, async () => {
    const contribution = createModelingTools({ projectRoot: root }).find(
      (t) => t.descriptor.id === 'model.diff',
    );
    expect(contribution?.descriptor.path).toEqual(operationCommandPath('model.diff'));
    const out = await tool('model.diff')({
      source,
      against: { values: { wall: 0.003, vents: 8 } },
    });
    expect(out.error).toBeUndefined();
    const report = out.value as {
      schema: string;
      a: { values: unknown; output?: string; build: { ok: boolean } };
      b: { values: unknown; build: { ok: boolean } };
      diff: MeshDiff;
      render: { frame: number[]; a: { frame: number[] }; b: { values: unknown } };
    };
    expect(report.schema).toBe(MODEL_DIFF_REPORT);
    expect(report.a.output).toBe('mesh/housing');
    expect(report.a.build.ok && report.b.build.ok).toBe(true);
    expect(report.b.values).toEqual({ wall: 0.003, vents: 8 });
    const { diff } = report;
    expect(diff.identical).toBe(false);
    expect(diff.counts.faces).toEqual({ a: 722, b: 818, delta: 96 });
    expect(diff.closed).toEqual({ a: true, b: true });
    expect(diff.volume.delta).toBeGreaterThan(0);
    const inner = diff.provenance.find((p) => p.label === 'vent' && p.role === 'rim');
    expect(inner).toMatchObject({ a: 20, b: 32 });
    const lip = diff.provenance.find((p) => p.label === 'lip-up' && p.role === 'top');
    expect(lip).toMatchObject({ a: 50, b: 56 });
    expect(report.render.frame).toEqual(diff.bounds.frame);
    expect(report.render.a.frame).toEqual(diff.bounds.frame);
    expect(report.render.b.values).toEqual({ wall: 0.003, vents: 8 });
  });

  it('model.diff compares two checkpoints and reports no change against itself', { timeout: 120000 }, async () => {
    const steps = await tool('model.diff')({
      source,
      checkpoint: 'solid',
      against: { checkpoint: 'shelled' },
    });
    expect(steps.error).toBeUndefined();
    const diff = (steps.value as { diff: MeshDiff }).diff;
    expect(diff.provenance.find((p) => p.label === 'wall' && p.role === 'inner')?.b).toBe(106);
    expect(diff.volume.delta).toBeLessThan(0);
    const same = await tool('model.diff')({ source, against: {} });
    expect((same.value as { diff: MeshDiff }).diff.identical).toBe(true);
    const missing = await tool('model.diff')({ source, against: { checkpoint: 'nope' } });
    expect(missing.error?.code).toBe('model-selection-empty');
  });

  it('validates with only intended thin-wall facts', { timeout: 120000 }, async () => {
    const out = await tool('model.validate')({ source });
    const report = out.value as {
      status: string;
      sessions: { issues: { code: string; severity: string }[]; operations: unknown[] }[];
    };
    expect(report.status).toBe('pass');
    expect(report.sessions[0]?.operations).toEqual([]);
  });
});
