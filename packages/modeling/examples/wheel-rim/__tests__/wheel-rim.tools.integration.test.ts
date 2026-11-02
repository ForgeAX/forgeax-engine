import { fileURLToPath } from 'node:url';
import type { MeshDiff } from '@forgeax/engine-modeling';
import { createModelingTools, MODEL_DIFF_REPORT } from '@forgeax/engine-modeling/tools';
import { describe, expect, it } from 'vitest';

/** C-101 through the capture Worker and Pack loading that `forgeax model *` use. */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = 'examples/wheel-rim/wheel-rim.pack.ts';

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

describe('C-101 through the real Pack loader', () => {
  it('validates every session and selects the spoke windows under two spoke counts', { timeout: 180000 }, async () => {
    const report = await tool('model.validate')({ source });
    expect(report.error).toBeUndefined();
    const value = report.value as { status: string; sessions: { output?: string; status: string; mesh: { closed: boolean } }[] };
    expect(value.status).toBe('pass');
    const rim = value.sessions.filter((s) => s.output === 'mesh/wheel-rim');
    expect(rim).toHaveLength(1);
    expect(rim[0]?.mesh.closed).toBe(true);
    for (const [spokes, count] of [[5, 140], [7, 196]] as const) {
      const selected = await tool('model.select')({ source, values: { spokes }, selector: "sel.createdBy('windows', 'cutB')" });
      expect(selected.error).toBeUndefined();
      expect(selected.value?.selected).toMatchObject({ domain: 'face', count });
    }
  });

  it('model.diff compares five spokes with seven', { timeout: 180000 }, async () => {
    const out = await tool('model.diff')({ source, against: { values: { spokes: 7 } } });
    expect(out.error).toBeUndefined();
    const report = out.value as {
      schema: string;
      a: { output?: string; build: { ok: boolean } };
      b: { values: unknown; build: { ok: boolean } };
      diff: MeshDiff;
      render: { frame: number[] };
    };
    expect(report.schema).toBe(MODEL_DIFF_REPORT);
    expect(report.a.output).toBe('mesh/wheel-rim');
    expect(report.a.build.ok && report.b.build.ok).toBe(true);
    const { diff } = report;
    expect(diff.identical).toBe(false);
    expect(diff.closed).toEqual({ a: true, b: true });
    expect(diff.volume.delta).toBeGreaterThan(0);
    // Provenance groups split by tag: each window keeps its array copy tag.
    const faces = (label: string, role: string) =>
      diff.provenance
        .filter((p) => p.label === label && p.role === role)
        .reduce((sum, p) => ({ a: sum.a + p.a, b: sum.b + p.b }), { a: 0, b: 0 });
    expect(faces('windows', 'cutB')).toEqual({ a: 140, b: 196 });
    const chamfer = faces('window-chamfer', 'bevel');
    expect(chamfer.a).toBeGreaterThanOrEqual(140);
    expect(chamfer.b).toBeGreaterThanOrEqual(196);
    expect(report.render.frame).toEqual(diff.bounds.frame);
  });
});
