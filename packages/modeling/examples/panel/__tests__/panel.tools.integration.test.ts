import { fileURLToPath } from 'node:url';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { describe, expect, it } from 'vitest';

/** C-011 through the capture Worker and module loading that `forgeax model *` use. */
const root = fileURLToPath(new URL('../../../', import.meta.url));

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

describe('C-011 through the real Pack loader', () => {
  it('captures every session unpoisoned and validates the panel as one closed solid', {
    timeout: 120000,
  }, async () => {
    const source = 'examples/panel/panel.pack.ts';
    const out = await tool('model.inspect')({ source });
    expect(out.error).toBeUndefined();
    const sessions = out.value?.sessions as { output?: string; poisoned?: unknown }[];
    expect(sessions.every((s) => s.poisoned === undefined)).toBe(true);
    expect(sessions.filter((s) => s.output === 'mesh/panel')).toHaveLength(1);
    const report = await tool('model.validate')({ source, values: { thickness: 0.009 } });
    expect(report.ok).toBe(true);
    const panel = (report.value?.sessions as { output?: string; status: string; mesh: { closed: boolean } }[]).find(
      (s) => s.output === 'mesh/panel',
    );
    expect(panel?.mesh.closed).toBe(true);
    expect(panel?.status).not.toBe('fail');
    const selected = await tool('model.select')({ source, selector: "sel.createdBy('drill', 'cutB')" });
    expect(selected.value?.selected).toMatchObject({ domain: 'face', count: 128 });
  });
});
