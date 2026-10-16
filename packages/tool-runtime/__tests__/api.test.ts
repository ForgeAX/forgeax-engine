import { describe, expect, it } from 'vitest';
import {
  createToolApi,
  defineTool,
  TOOL_REALMS,
  type ToolContribution,
} from '../src/index.js';

const schema = { parse: (value: unknown) => ({ ok: true as const, value }) };

function tool(id: string, execute: ToolContribution['execute']): ToolContribution {
  return defineTool(
    {
      id,
      title: id,
      summary: `Operation ${id}`,
      path: id.split('.'),
      realm: 'engine',
      argsSchema: schema,
      resultSchema: schema,
      evidence: [],
    },
    execute,
  );
}

describe('Tool API provider admission', () => {
  it('keeps the public realm vocabulary immutable', () => {
    expect(TOOL_REALMS).toEqual(['build', 'host', 'engine', 'frontend']);
    expect(Reflect.set(TOOL_REALMS, 0, 'unsupported')).toBe(false);
  });

  it.each(['build', 'host', 'engine', 'frontend'] as const)('calls a %s provider with trusted realm identity', async (realm) => {
    const api = createToolApi();
    try {
      const operation = defineTool(
        { ...tool(`fixture.${realm}`, () => realm).descriptor, realm },
        (_args, context) => context.owner?.realm,
      );
      api.registerProvider({ providerId: realm, sourceId: 'fixture', realm, tools: [operation] });
      await expect(api.run(operation.descriptor.id, null).terminal).resolves.toMatchObject({
        outcome: 'succeeded', result: realm,
      });
    } finally {
      await api.dispose();
    }
  });

  it('rejects an unsupported provider realm before admission', async () => {
    const api = createToolApi();
    try {
      expect(() => api.registerProvider({
        providerId: 'invalid', sourceId: 'fixture',
        realm: 'worker' as never, tools: [tool('fixture.invalid', () => null)],
      })).toThrow('unsupported Tool API realm worker');
    } finally {
      await api.dispose();
    }
  });

  it('routes a callable operation with trusted owner and caller facts', async () => {
    let observed: unknown;
    const operation = tool('fixture.answer', async (_args, context) => {
      observed = { owner: context.owner, caller: context.caller };
      return 42;
    });
    const api = createToolApi();
    const provider = api.registerProvider({
      providerId: 'fixture-provider',
      sourceId: 'backend',
      realm: 'engine',
      fiberId: 7,
      module: '@fixture/provider',
      tools: [operation],
    });

    const run = api.run('fixture.answer', null, {
      providerId: 'fixture-provider',
      sourceId: 'backend',
      caller: { connectionId: 'connection-a', kind: 'in-process' },
    });
    await expect(run.terminal).resolves.toMatchObject({ outcome: 'succeeded', result: 42 });
    expect(observed).toEqual({
      owner: {
        providerId: 'fixture-provider',
        sourceId: 'backend',
        generation: provider.owner.generation,
        realm: 'engine',
        fiberId: 7,
        module: '@fixture/provider',
      },
      caller: { connectionId: 'connection-a', kind: 'in-process' },
    });
    expect(api.describe('fixture.answer', 'backend')[0]).toMatchObject({
      callable: true,
      owner: provider.owner,
    });
    await api.dispose();
  });

  it('requires an explicit provider route for duplicate operation ids across sources', async () => {
    const first = tool('fixture.shared', async () => 'first');
    const second = tool('fixture.shared', async () => 'second');
    const api = createToolApi();
    api.registerProvider({ providerId: 'one', sourceId: 'source-a', realm: 'engine', tools: [first] });
    api.registerProvider({ providerId: 'two', sourceId: 'source-b', realm: 'engine', tools: [second] });

    const ambiguous = await api.run('fixture.shared', null).terminal;
    expect(ambiguous).toMatchObject({
      outcome: 'failed',
      failure: { detail: { code: 'api-provider-route-required' } },
    });
    await expect(
      api.run('fixture.shared', null, { providerId: 'two', sourceId: 'source-b' }).terminal,
    ).resolves.toMatchObject({ outcome: 'succeeded', result: 'second' });
    await api.dispose();
  });

  it('withdraws admission before waiting for an executor that ignores cancellation', async () => {
    let release: (() => void) | undefined;
    let exited = false;
    const pending = tool('fixture.pending', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      exited = true;
      return 'done';
    });
    const api = createToolApi();
    const provider = api.registerProvider({
      providerId: 'pending-provider',
      sourceId: 'backend',
      realm: 'engine',
      tools: [pending],
    });
    const run = api.run('fixture.pending', null, {
      providerId: 'pending-provider',
      sourceId: 'backend',
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const revocation = provider.revoke('test unload');
    expect(provider.snapshot()).toMatchObject({ state: 'revoking', callable: false });
    expect(await Promise.race([revocation.then(() => 'done'), Promise.resolve('pending')])).toBe('pending');
    expect(
      await api.run('fixture.pending', null, {
        providerId: 'pending-provider',
        sourceId: 'backend',
      }).terminal,
    ).toMatchObject({
      outcome: 'failed',
      failure: { detail: { code: 'api-operation-unavailable' } },
    });
    expect(exited).toBe(false);
    release?.();
    await revocation;
    await run.executorExited;
    expect(exited).toBe(true);
    expect(provider.snapshot()).toMatchObject({ state: 'revoked', callable: false });
    await api.dispose();
  });

  it('rejects stale generations and provider authorization failures', async () => {
    const operation = tool('fixture.secure', async () => 'ok');
    const api = createToolApi();
    const provider = api.registerProvider({
      providerId: 'secure-provider',
      sourceId: 'backend',
      realm: 'engine',
      generation: 9,
      tools: [operation],
      authorize: (caller) => caller?.connectionId === 'allowed',
    });
    await expect(
      api.run('fixture.secure', null, {
        providerId: provider.owner.providerId,
        sourceId: provider.owner.sourceId,
        generation: 8,
      }).terminal,
    ).resolves.toMatchObject({ outcome: 'failed', failure: { detail: { code: 'api-stale-generation' } } });
    await expect(
      api.run('fixture.secure', null, {
        providerId: provider.owner.providerId,
        sourceId: provider.owner.sourceId,
        generation: 9,
        caller: { connectionId: 'forged' },
      }).terminal,
    ).resolves.toMatchObject({ outcome: 'failed', failure: { detail: { code: 'api-unauthorized' } } });
    await expect(
      api.run('fixture.secure', null, {
        providerId: provider.owner.providerId,
        sourceId: provider.owner.sourceId,
        generation: 9,
        caller: { connectionId: 'allowed' },
      }).terminal,
    ).resolves.toMatchObject({ outcome: 'succeeded', result: 'ok' });
    await api.dispose();
  });
});
