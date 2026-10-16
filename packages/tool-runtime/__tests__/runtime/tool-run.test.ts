import { describe, expect, it } from 'vitest';
import { createToolRuntime, defineTool } from '../../src/index.js';

const textSchema = {
  parse(value: unknown) {
    return typeof value === 'string'
      ? { ok: true as const, value }
      : { ok: false as const, error: 'expected a string' };
  },
};

describe('ToolRun lexical state', () => {
  it('propagates child failure and emits one terminal event', async () => {
    const child = defineTool(
      {
        id: 'test.child-failure',
        title: 'Child failure',
        summary: 'Fails as a producer would.',
        realm: 'build',
        argsSchema: textSchema,
        resultSchema: textSchema,
        evidence: [],
      },
      async () => ({ ok: false as const, error: { code: 'producer-failed', detail: { message: 'bad' } } }),
    );
    const parent = defineTool(
      {
        id: 'test.parent',
        title: 'Parent',
        summary: 'Owns a child lease.',
        realm: 'build',
        argsSchema: textSchema,
        resultSchema: textSchema,
        evidence: [],
      },
      async (_args, context) => {
        const childTerminal = await context.runChild(child, 'child');
        if (childTerminal.outcome === 'failed') return childTerminal;
        return { ok: true as const, value: childTerminal.result };
      },
    );
    const runtime = createToolRuntime([parent, child]);
    const run = runtime.run(parent, 'root');
    const events: string[] = [];
    for await (const event of run.events) events.push(event.kind);
    const terminal = await run.terminal;

    expect(terminal.outcome).toBe('failed');
    expect(events.filter((kind) => kind === 'terminal')).toHaveLength(1);
  });

  it('cancels a pending run and rejects work after terminal', async () => {
    let resolveWork: (() => void) | undefined;
    const pending = defineTool(
      {
        id: 'test.pending',
        title: 'Pending',
        summary: 'Waits for cancellation.',
        realm: 'build',
        argsSchema: textSchema,
        resultSchema: textSchema,
        evidence: [],
      },
      async (_args, context) => {
        await new Promise<void>((resolve) => {
          resolveWork = resolve;
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'finished';
      },
    );
    const runtime = createToolRuntime([pending]);
    const run = runtime.run(pending, 'root');
    run.cancel('user requested stop');
    const terminal = await run.terminal;
    resolveWork?.();
    expect(terminal.outcome).toBe('failed');
    if (terminal.outcome === 'failed') expect(terminal.failure.code).toBe('tool-run-cancelled');
    expect(() => run.cancel('second stop')).not.toThrow();
  });

  it('runs cleanup in reverse registration order', async () => {
    const order: string[] = [];
    const tool = defineTool(
      {
        id: 'test.cleanup',
        title: 'Cleanup',
        summary: 'Registers lexical cleanup.',
        realm: 'build',
        argsSchema: textSchema,
        resultSchema: textSchema,
        evidence: [],
      },
      async (_args, context) => {
        context.addCleanup(() => {
          order.push('first');
        });
        context.addCleanup(() => {
          order.push('second');
        });
        return 'done';
      },
    );
    const terminal = await createToolRuntime([tool]).run(tool, 'root').terminal;
    expect(terminal.outcome).toBe('succeeded');
    expect(order).toEqual(['second', 'first']);
  });

  it('fails when descriptor or run options request evidence that was not produced', async () => {
    const required = defineTool(
      {
        id: 'test.required-evidence',
        title: 'Required evidence',
        summary: 'Requires one owner-produced PNG artifact.',
        realm: 'host',
        argsSchema: textSchema,
        resultSchema: textSchema,
        evidence: ['png'],
      },
      async () => 'done',
    );
    const runtime = createToolRuntime([required]);
    const descriptorFailure = await runtime.run(required, 'root').terminal;
    expect(descriptorFailure).toMatchObject({
      outcome: 'failed',
      failure: { code: 'tool-artifact-incomplete', detail: { missing: ['png'] } },
    });

    const optional = defineTool(
      { ...required.descriptor, id: 'test.requested-evidence', evidence: [] },
      async () => 'done',
    );
    const requestedFailure = await runtime.run(optional, 'root', { evidence: ['png'] }).terminal;
    expect(requestedFailure).toMatchObject({
      outcome: 'failed',
      failure: { code: 'tool-artifact-incomplete', detail: { missing: ['png'] } },
    });
  });

  it('joins phase timing into the terminal without replacing the total duration', async () => {
    const timed = defineTool(
      {
        id: 'test.timing',
        title: 'Timing',
        summary: 'Produces a phase-attributed terminal.',
        realm: 'build',
        argsSchema: textSchema,
        resultSchema: textSchema,
        evidence: [],
      },
      async () => 'done',
    );
    const terminal = await createToolRuntime([timed]).run(timed, 'root').terminal;
    expect(terminal).toMatchObject({ outcome: 'succeeded', timing: { phases: { lookup: { status: 'observed', durationMs: expect.any(Number) }, lease: { status: 'observed', durationMs: expect.any(Number) }, execute: { status: 'observed', durationMs: expect.any(Number) }, finalize: { status: 'observed', durationMs: expect.any(Number) }, capture: { status: 'not-applicable' } } } });
    if (terminal.outcome === 'succeeded') {
      expect(terminal.timing?.durationMs).toBeGreaterThanOrEqual(0);
      const execute = terminal.timing?.phases?.execute;
      expect(execute?.status).toBe('observed');
      if (execute?.status === 'observed') expect(execute.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
