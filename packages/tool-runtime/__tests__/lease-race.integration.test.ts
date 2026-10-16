import { describe, expect, it } from 'vitest';
import { createLexicalLease } from '../src/lease.js';
import { createToolRuntime, defineTool, defineToolCapability } from '../src/index.js';

describe('lexical lease termination races', () => {
  it.each(['terminal', 'cancel', 'timeout', 'disconnect', 'provider-exit'] as const)(
    'cleans %s owners in reverse registration order and settles once',
    async (reason) => {
      const released: string[] = [];
      const lease = createLexicalLease(`run:${reason}`);
      for (const owner of ['context', 'port', 'page', 'canvas', 'fiber']) {
        expect(lease.register(owner, () => released.push(owner))).toBe(true);
      }

      const [first, second] = await Promise.all([
        lease.terminate(reason),
        lease.terminate('terminal'),
      ]);
      expect(first.terminalId).toBe(second.terminalId);
      expect(released).toEqual(['fiber', 'canvas', 'page', 'port', 'context']);
      expect(lease.register('late', () => released.push('late'))).toBe(false);
    },
  );

  it('returns structured cleanup failures without leaving a detached owner', async () => {
    const lease = createLexicalLease('run:cleanup-failure');
    lease.register('page', () => {
      throw new Error('page already closed');
    });
    const result = await lease.terminate('terminal');
    expect(result.failures).toEqual([
      { owner: 'page', message: 'page already closed' },
    ]);
    expect(lease.state).toBe('terminated');
  });

  it('does not resolve a capability after the ToolRun terminal lease', async () => {
    const capability = defineToolCapability<{ readonly active: boolean }>('fixture.lease');
    let resolveCapability: (() => unknown) | undefined;
    const tool = defineTool(
      {
        id: 'fixture.lease-race',
        title: 'Lease race fixture',
        summary: 'Observes capability invalidation after terminal.',
        realm: 'host',
        argsSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
        resultSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
        evidence: [],
      },
      (_value, context) => {
        resolveCapability = () => context.require(capability);
        return { ok: true as const, value: 'ready' };
      },
    );
    const terminal = await createToolRuntime([tool]).run(tool, null, {
      capabilityResolver: () => ({ ok: true as const, value: { active: true } }),
    }).terminal;
    expect(terminal.outcome).toBe('succeeded');
    expect(resolveCapability?.()).toMatchObject({
      ok: false,
      error: { code: 'tool-run-terminal' },
    });
  });
});
