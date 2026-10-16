import { describe, expect, it } from 'vitest';
import { createToolRuntime, defineTool, type ToolCleanupReport } from '../../src/index.js';

const schema = { parse: (value: unknown) => ({ ok: true as const, value }) };

describe('preview terminal cleanup contract', () => {
  it('requires a zero live-resource census after provider exit', async () => {
    const report: ToolCleanupReport = {
      census: { worlds: 0, renderers: 0, canvases: 0, leases: 0 },
      failures: [],
    };
    const tool = defineTool(
      {
        id: 'preview.provider-exit',
        title: 'Provider exit',
        summary: 'Models a provider disappearing during preview.',
        realm: 'engine',
        argsSchema: schema,
        resultSchema: schema,
        evidence: [],
      },
      async () => ({ ok: true as const, value: { cleanup: report } }),
    );
    const run = createToolRuntime([tool]).run(tool, {});
    run.providerExit('preview-provider');
    const terminal = await run.terminal;

    expect(terminal).toMatchObject({
      outcome: 'failed',
      failure: { code: 'tool-domain-failed', detail: { code: 'provider-exit' } },
      cleanup: { census: { worlds: 0, renderers: 0, canvases: 0, leases: 0 } },
    });
  });

  it('publishes exactly one terminal even when provider exit races executor completion', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    const tool = defineTool(
      {
        id: 'preview.race',
        title: 'Terminal race',
        summary: 'Ensures terminal ownership is unique.',
        realm: 'engine',
        argsSchema: schema,
        resultSchema: schema,
        evidence: [],
      },
      async () => new Promise((done) => { resolve = done; }),
    );
    const run = createToolRuntime([tool]).run(tool, {});
    const terminalEvents: unknown[] = [];
    const consume = (async () => {
      for await (const event of run.events) if (event.kind === 'terminal') terminalEvents.push(event);
    })();
    run.providerExit('preview-provider');
    resolve?.({ ok: true, value: { done: true } });
    const terminal = await run.terminal;
    await consume;

    expect(terminalEvents).toHaveLength(1);
    expect(terminal.outcome).toBe('failed');
  });

  it('turns a non-zero post-dispose census into a cleanup failure', async () => {
    const tool = defineTool(
      {
        id: 'preview.leaked-resource',
        title: 'Leaked resource',
        summary: 'Rejects a success terminal with a live resource census.',
        realm: 'engine',
        argsSchema: schema,
        resultSchema: schema,
        evidence: [],
      },
      async (_args, context) => {
        context.setCleanupReport({
          census: { worlds: 1, renderers: 0, canvases: 0, leases: 0 },
          failures: [],
        });
        return 'done';
      },
    );
    const terminal = await createToolRuntime([tool]).run(tool, {}).terminal;

    expect(terminal).toMatchObject({
      outcome: 'failed',
      failure: { code: 'tool-cleanup-failed' },
      cleanup: { census: { worlds: 1 } },
    });
  });
});
