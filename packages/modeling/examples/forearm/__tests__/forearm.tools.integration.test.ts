import { fileURLToPath } from 'node:url';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { describe, expect, it } from 'vitest';

/** C-016 through the capture Worker and module loading that `forgeax model *` use. */
const root = fileURLToPath(new URL('../../../', import.meta.url));

function tool(id: string) {
  const contribution = createModelingTools({ projectRoot: root }).find((t) => t.descriptor.id === id);
  if (contribution === undefined) throw new Error(id);
  return (args: Record<string, unknown>) =>
    contribution.execute(args as never, {} as never) as Promise<{
      ok: boolean;
      value?: Record<string, unknown>;
      error?: { code: string; expected?: string };
    }>;
}

describe('C-016 through the real Pack loader', () => {
  it('captures both sessions unpoisoned with the arap and smooth.implicit history', { timeout: 120000 }, async () => {
    const source = 'examples/forearm/forearm.pack.ts';
    const out = await tool('model.inspect')({ source });
    expect(out.error).toBeUndefined();
    const sessions = out.value?.sessions as { poisoned?: unknown }[];
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.poisoned === undefined)).toBe(true);
    const report = await tool('model.validate')({ source, values: { wrist: 45 } });
    expect(report.ok).toBe(true);
    const validated = report.value?.sessions as { status: string; mesh: { closed: boolean } }[];
    expect(validated.every((s) => s.mesh.closed && s.status !== 'fail')).toBe(true);
    const history = await tool('model.history')({ source, session: 0 });
    expect(history.error).toBeUndefined();
    const ops = JSON.stringify(history.value);
    expect(ops).toContain('"arap"');
    expect(ops).toContain('"smooth.implicit"');
  });
});
