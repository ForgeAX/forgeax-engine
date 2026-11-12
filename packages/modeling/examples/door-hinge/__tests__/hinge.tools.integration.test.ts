import { fileURLToPath } from 'node:url';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { describe, expect, it } from 'vitest';

/**
 * C-103 through the real Pack loader: every recipe session and the assembly validate
 * without errors or warnings (informational operation diagnostics only).
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = 'examples/door-hinge/hinge.pack.ts';

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

describe('C-103 through the real Pack loader', () => {
  it('validates the recipe sessions and the assembly', { timeout: 300000 }, async () => {
    const validation = await tool('model.validate')({ source });
    expect(validation.error).toBeUndefined();
    const report = validation.value as {
      status: string;
      sessions: {
        status: string;
        output?: string;
        issues: { severity: string }[];
        operations: { diagnostics: { severity: string }[] }[];
      }[];
    };
    // `warn` here only means some operation reported a diagnostic; all of them are infos.
    expect(report.status).not.toBe('fail');
    expect(report.sessions.length).toBeGreaterThan(3);
    for (const session of report.sessions) {
      expect(session.status).not.toBe('fail');
      expect(session.issues.filter((i) => i.severity !== 'info')).toEqual([]);
      const severities = session.operations.flatMap((o) => o.diagnostics.map((d) => d.severity));
      expect(severities.filter((s) => s !== 'info')).toEqual([]);
    }
    expect(report.sessions.map((s) => s.output)).toContain('mesh/door-hinge');
  });
});
