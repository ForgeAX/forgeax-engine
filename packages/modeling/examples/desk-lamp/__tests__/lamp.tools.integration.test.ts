import { fileURLToPath } from 'node:url';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { describe, expect, it } from 'vitest';

/** C-002 through the capture Worker and module loading that `forgeax model *` use. */
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

describe('C-002 through the real Pack loader', () => {
  it('inspects six sessions; select defaults to the session that produced mesh/lamp', {
    timeout: 120000,
  }, async () => {
    const source = 'examples/desk-lamp/lamp.pack.ts';
    const out = await tool('model.inspect')({ source });
    expect(out.error).toBeUndefined();
    const sessions = out.value?.sessions as { output?: string; poisoned?: unknown }[];
    expect(sessions).toHaveLength(6);
    expect(sessions.every((s) => s.poisoned === undefined)).toBe(true);
    expect(sessions.map((s) => s.output ?? null)).toEqual([null, null, null, null, null, 'mesh/lamp']);
    const selected = await tool('model.select')({
      source,
      selector: "sel.createdBy('vent-depth', 'top')",
      values: { height: 0.3, reach: 20, shadeRadius: 0.1 },
    });
    expect(selected.value?.selected).toMatchObject({ session: 5, domain: 'face', count: 6 });
  });

  it('a product-reuse reader cannot be captured: inspect the upstream Pack instead', {
    timeout: 120000,
  }, async () => {
    const out = await tool('model.inspect')({ source: 'examples/desk-lamp/lamp-pair.pack.ts' });
    const build = out.value?.build as { ok: boolean; error?: { code: string } };
    expect(build.ok).toBe(false);
    expect(build.error?.code).toBe('model-capability-unavailable');
  });
});
