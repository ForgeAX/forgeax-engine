import { fileURLToPath } from 'node:url';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { describe, expect, it } from 'vitest';

/** C-106 through the capture Worker and module loading that `forgeax model *` use. */
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

describe('C-106 through the real Pack loader', () => {
  it('builds mesh/body-panels with its surfaces and validates without issues', { timeout: 180000 }, async () => {
    const source = 'examples/body-panels/panels.pack.ts';
    const out = await tool('model.inspect')({ source });
    expect(out.error).toBeUndefined();
    const sessions = out.value?.sessions as { output?: string; checkpoints: { name: string }[] }[];
    expect(sessions.map((s) => s.output ?? null)).toEqual(['mesh/body-panels']);
    expect(sessions[0]?.checkpoints.map((c) => c.name)).toEqual(['surfaces']);
    const report = await tool('model.validate')({ source });
    expect(report.error).toBeUndefined();
    // Only the shell's soft thickness assertion may warn (curved walls, micrometers).
    const sessions2 = report.value?.sessions as { issues: unknown[]; operations: { diagnostics: { severity: string; message: string }[] }[] }[];
    expect(sessions2[0]?.issues).toEqual([]);
    const warnings = sessions2[0]?.operations.flatMap((o) => o.diagnostics.filter((d) => d.severity === 'warn')) ?? [];
    expect(warnings.every((d) => d.message.includes('differ from thickness'))).toBe(true);
    const carbon = await tool('model.select')({ source, selector: "sel.tag('carbon')" });
    expect((carbon.value?.selected as { count: number }).count).toBeGreaterThan(0);
  });
});
