import { fileURLToPath } from 'node:url';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { describe, expect, it } from 'vitest';

/** C-014 through the capture Worker and module loading that `forgeax model *` use. */
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

describe('C-014 through the real Pack loader', () => {
  it('captures both sessions unpoisoned and validates them as closed solids', { timeout: 120000 }, async () => {
    const source = 'examples/pauldron/pauldron.pack.ts';
    const out = await tool('model.inspect')({ source });
    expect(out.error).toBeUndefined();
    const sessions = out.value?.sessions as { poisoned?: unknown }[];
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.poisoned === undefined)).toBe(true);
    const report = await tool('model.validate')({ source, values: { curl: 125 } });
    expect(report.ok).toBe(true);
    const validated = report.value?.sessions as { status: string; mesh: { closed: boolean } }[];
    expect(validated.every((s) => s.mesh.closed && s.status !== 'fail')).toBe(true);
    const selected = await tool('model.select')({ source, session: 0, selector: "sel.tag('collar')" });
    expect(selected.value?.selected).toMatchObject({ domain: 'face', count: 256 });
  });
});
