import { type Plugin, registerTools } from '@forgeax/engine-plugin';
import { expect, it } from 'vitest';
import { createBackendHost } from '../backend.js';

it('installs native tool providers with Host ownership', async () => {
  const schema = { parse: (value: unknown) => ({ ok: true as const, value }) };
  const tool = {
    descriptor: {
      id: 'host.test',
      title: 'test',
      summary: 'test',
      realm: 'host' as const,
      argsSchema: schema,
      resultSchema: schema,
      evidence: [],
    },
    execute: () => 42,
  };
  const plugin: Plugin = {
    inject: ['toolApi'],
    apply(ctx) {
      ctx.effect(() => registerTools(ctx, [tool], { realm: 'host' }));
    },
  };
  const host = await createBackendHost({ startupPlugins: [plugin] });
  const api = host.context.toolApi;
  if (!api) throw new Error('required fixture api missing');
  expect(await api.run('host.test', {}).terminal).toMatchObject({
    outcome: 'succeeded',
    result: 42,
  });
  await host.dispose();
  expect(api.list().every((row) => !row.callable)).toBe(true);
});
