import { Context } from '@deepseek-ai/cordis';
import { defineTool, toolJsonSchema } from '@forgeax/engine-tool-runtime';
import { describe, expect, it } from 'vitest';
import { registerTools } from '../register-tools.js';
import { startNativePlugin } from '../startup.js';
import { createToolApiPlugin } from '../tool-api.js';

const schema = toolJsonSchema({});
const tool = defineTool(
  {
    id: 'test.tool',
    title: 'test',
    summary: 'test',
    realm: 'engine',
    argsSchema: schema,
    resultSchema: schema,
    evidence: [],
  },
  () => 42,
);

describe('native tool registration', () => {
  it('admits only active native providers and reports ambiguity between instances', async () => {
    const ctx = new Context();
    await ctx.plugin(createToolApiPlugin());
    if (!ctx.toolApi) throw new Error('required fixture ctx.toolApi missing');
    const plugin = {
      inject: ['toolApi'],
      apply(ctx: Context) {
        ctx.effect(() => registerTools(ctx, [tool]));
      },
    };
    const first = await startNativePlugin(ctx, plugin);
    expect(first.ok).toBe(true);
    expect(await ctx.toolApi.run('test.tool', {}).terminal).toMatchObject({
      outcome: 'succeeded',
      result: 42,
    });
    const second = await startNativePlugin(ctx, plugin);
    expect(second.ok).toBe(true);
    expect(await ctx.toolApi.run('test.tool', {}).terminal).toMatchObject({ outcome: 'failed' });
    if (second.ok) await second.value.dispose();
    expect(await ctx.toolApi.run('test.tool', {}).terminal).toMatchObject({
      outcome: 'succeeded',
    });
    await ctx.fiber.dispose();
    expect(ctx.toolApi).toBeUndefined();
  });
  it('does not admit a provider during asynchronous apply', async () => {
    const ctx = new Context();
    await ctx.plugin(createToolApiPlugin());
    if (!ctx.toolApi) throw new Error('required fixture ctx.toolApi missing');
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fiber = ctx.plugin({
      inject: ['toolApi'],
      async apply(ctx) {
        ctx.effect(() => registerTools(ctx, [tool]));
        await wait;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.toolApi.list()[0]?.callable).toBe(false);
    release();
    await fiber.await();
    expect(ctx.toolApi.list()[0]?.callable).toBe(true);
    await ctx.fiber.dispose();
  });
  it('drains a revoked executor before releasing its dependent resource', async () => {
    const ctx = new Context();
    await ctx.plugin(createToolApiPlugin());
    if (!ctx.toolApi) throw new Error('required fixture ctx.toolApi missing');
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const events: string[] = [];
    const slow = defineTool({ ...tool.descriptor, id: 'test.slow' }, async () => {
      events.push('entered');
      await blocked;
      events.push('exited');
      return 1;
    });
    const result = await startNativePlugin(ctx, {
      inject: ['toolApi'],
      apply(ctx: Context) {
        ctx.effect(function* () {
          yield () => {
            events.push('resource-released');
          };
          yield registerTools(ctx, [slow]);
        });
      },
    });
    const run = ctx.toolApi.run('test.slow', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const disposal = result.unwrap().dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.toolApi.list()[0]?.callable).toBe(false);
    expect(events).toEqual(['entered']);
    finish();
    await disposal;
    await run.terminal;
    expect(events).toEqual(['entered', 'exited', 'resource-released']);
    await ctx.fiber.dispose();
  });
});
