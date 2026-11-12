import { fileURLToPath } from 'node:url';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { describe, expect, it } from 'vitest';

/** C-100 S6b through the capture Worker that `forgeax model validate` uses: every captured session, not only the output. */
const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('C-100 S6b robot Pack through the real Pack loader', () => {
  it('validates pass: no captured session is poisoned, the output has no issue above info', { timeout: 600000 }, async () => {
    const contribution = createModelingTools({ projectRoot: root, timeoutMs: 540000 }).find((t) => t.descriptor.id === 'model.validate');
    if (contribution === undefined) throw new Error('model.validate');
    const out = (await contribution.execute({ source: 'examples/mech-gt/s6b-robot.pack.ts' } as never, {} as never)) as {
      ok: boolean;
      value?: { status: string; sessions: { index: number; status: string; output?: string; poisoned?: { code: string } }[] };
    };
    expect(out.ok).toBe(true);
    const sessions = out.value?.sessions ?? [];
    expect(sessions.filter((s) => s.status !== 'pass').map((s) => [s.index, s.poisoned?.code])).toEqual([]);
    expect(sessions.some((s) => s.output === 'mesh/s6b-robot')).toBe(true);
    expect(out.value?.status).toBe('pass');
  });
});
