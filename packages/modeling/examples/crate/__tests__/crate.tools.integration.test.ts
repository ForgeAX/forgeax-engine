import { fileURLToPath } from 'node:url';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { describe, expect, it } from 'vitest';
import { buildCrate, CRATE_DEFAULTS } from '../crate';
import { attachSourceLines, recordingSessions } from '../../case/record';

/**
 * C-001 through the real Pack loader: the same capture Worker and module loading
 * that `forgeax model inspect|select|validate` use, not a direct vitest import.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = 'examples/crate/crate.pack.ts';

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

describe('C-001 through the real Pack loader', () => {
  it('inspects all five sessions and the finished crate', { timeout: 120000 }, async () => {
    const out = await tool('model.inspect')({ source });
    expect(out.error).toBeUndefined();
    const sessions = out.value?.sessions as { faces: number; poisoned?: unknown }[];
    expect(sessions).toHaveLength(5);
    expect(sessions.every((s) => s.poisoned === undefined)).toBe(true);
    expect(sessions.at(-1)?.faces).toBe(464);
  });

  it('validates clean and selects the same region under other parameters', { timeout: 120000 }, async () => {
    const validation = await tool('model.validate')({ source });
    expect(validation.error).toBeUndefined();
    const report = validation.value as {
      status: string;
      sessions: { status: string; issues: { severity: string }[] }[];
    };
    expect(report.status).toBe('pass');
    const crate = report.sessions.at(-1);
    expect(crate?.status).toBe('pass');
    expect(crate?.issues.filter((i) => i.severity === 'warn')).toEqual([]);
    const selected = await tool('model.select')({
      source,
      session: 4,
      selector: "sel.createdBy('recess', 'top')",
      values: { width: 1.6, height: 0.3, depth: 0.9 },
    });
    expect(selected.error).toBeUndefined();
    expect(selected.value?.selected).toMatchObject({ domain: 'face', count: 4 });
  });

  it('history reports the build source line of every crate operation', { timeout: 120000 }, async () => {
    const out = await tool('model.history')({ source });
    expect(out.error).toBeUndefined();
    const sessions = out.value?.sessions as {
      output?: string;
      steps: { op: string; source?: { path: string; line: number } }[];
      checkpoints: { name: string; source?: { line: number } }[];
    }[];
    const crate = sessions.find((s) => s.output === 'mesh/crate');
    const recording = recordingSessions();
    buildCrate(CRATE_DEFAULTS, recording.session);
    const expected = attachSourceLines(recording.steps, fileURLToPath(new URL('../crate.ts', import.meta.url)))
      .filter((step) => step.session === 'crate')
      .map((step) => [step.entry.op, step.line]);
    expect(crate?.steps.map((step) => [step.op, step.source?.line])).toEqual(expected);
    expect(new Set(crate?.steps.map((step) => step.source?.path))).toEqual(
      new Set(['examples/crate/crate.ts']),
    );
    expect(crate?.checkpoints.map((c) => c.name)).toEqual(['banded', 'panels', 'lid', 'base', 'assembled']);
  });
});
