import { createToolRuntime, defineTool, defineToolCapability } from '@forgeax/engine/tool-runtime';
import { defineFeature } from '../../lab/feature';
import { numberField } from './_shared/schema';

const clock = defineToolCapability<{ readonly now: () => number }>('lab.clock');
const schema = numberField('value');

function tool(
  id: string,
  execute: Parameters<typeof defineTool<{ value: number }, { value: number }>>[1],
) {
  return defineTool(
    {
      id,
      title: id,
      summary: `${id} probe`,
      realm: 'build',
      argsSchema: schema,
      resultSchema: schema,
      evidence: [],
    },
    execute,
  );
}

export default defineFeature({
  title: 'Lexical ToolRun terminal',
  catalog: 'Lexical ToolRun terminal',
  kind: 'headless',
  summary:
    'A ToolRun owns a lexical lease: registered cleanups run before the terminal resolves, a non-zero live-resource census turns success into tool-cleanup-failed, and a context retained past terminal refuses capabilities.',
  expect:
    'cleanup runs before terminal; a leaked renderer count fails with tool-cleanup-failed; cancel and deadline produce tool-run-cancelled / tool-run-timeout and signal the executor; a missing capability is tool-capability-unavailable; the retained context reports tool-run-terminal.',
  async run(checks) {
    let retained: Parameters<Parameters<typeof tool>[1]>[1] | undefined;
    let cleaned = false;
    let missingCode = '';
    const tidy = tool('lab.tidy', async (args, context) => {
      retained = context;
      context.addCleanup(() => {
        cleaned = true;
      });
      const now = context.require(clock);
      if (!now.ok) missingCode = now.error.code;
      return { ok: true, value: { value: now.ok ? now.value.now() : args.value } };
    });
    const leaky = tool('lab.leaky', async (args, context) => {
      context.setCleanupReport({
        census: { worlds: 0, renderers: 1, canvases: 0, leases: 0 },
        failures: [],
      });
      return { ok: true, value: args };
    });
    const slow = tool(
      'lab.slow',
      (args, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener('abort', () => resolve({ ok: true, value: args }));
        }),
    );
    const runtime = createToolRuntime([tidy, leaky, slow]);

    const resolved = await runtime.run(
      tidy,
      { value: 1 },
      {
        capabilityResolver: (capability) =>
          capability.id === clock.id ? ({ ok: true, value: { now: () => 7 } } as never) : undefined,
      },
    ).terminal;
    checks.equal(
      'capability resolved',
      resolved.outcome === 'succeeded' ? resolved.result.value : -1,
      7,
    );
    checks.ok('cleanup ran before terminal', cleaned);

    const missing = await runtime.run(tidy, { value: 3 }).terminal;
    checks.equal(
      'missing capability falls back',
      missing.outcome === 'succeeded' ? missing.result.value : -1,
      3,
    );
    checks.equal('missing capability code', missingCode, 'tool-capability-unavailable');
    const direct = retained?.require(clock);
    checks.equal(
      'retained context after terminal',
      direct === undefined || direct.ok ? 'ok' : direct.error.code,
      'tool-run-terminal',
    );

    const leak = await runtime.run(leaky, { value: 1 }).terminal;
    checks.equal(
      'leak turns success into failure',
      leak.outcome === 'failed' ? leak.failure.code : 'succeeded',
      'tool-cleanup-failed',
    );
    checks.equal('leak census reported', leak.cleanup?.census.renderers, 1);

    const cancelled = runtime.run(slow, { value: 1 });
    cancelled.cancel('lab stop');
    const cancelTerminal = await cancelled.terminal;
    checks.equal(
      'cancel code',
      cancelTerminal.outcome === 'failed' ? cancelTerminal.failure.code : 'succeeded',
      'tool-run-cancelled',
    );
    await checks.run('executor observes abort', async () => {
      await cancelled.executorExited;
      return 'executorExited resolved';
    });
    const timed = await runtime.run(slow, { value: 1 }, { deadlineMs: 20 }).terminal;
    checks.equal(
      'deadline code',
      timed.outcome === 'failed' ? timed.failure.code : 'succeeded',
      'tool-run-timeout',
    );
  },
});
