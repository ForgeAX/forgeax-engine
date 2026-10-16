import { createToolRuntime, defineTool } from '@forgeax/engine/tool-runtime';
import { defineFeature } from '../../lab/feature';
import { numberField } from './_shared/schema';

const double = defineTool(
  {
    id: 'lab.double',
    title: 'Double',
    summary: 'Doubles a number.',
    realm: 'build',
    argsSchema: numberField('value'),
    resultSchema: numberField('doubled'),
    evidence: [],
  },
  async (args, context) => {
    context.emit({ kind: 'progress', runId: context.runId, message: 'doubling', atMs: 0 });
    return { ok: true, value: { doubled: args.value * 2 } };
  },
);

const refuse = defineTool(
  {
    id: 'lab.refuse',
    title: 'Refuse',
    summary: 'Always returns a domain failure.',
    realm: 'engine',
    argsSchema: numberField('value'),
    resultSchema: numberField('value'),
    evidence: [],
  },
  async () => ({
    ok: false,
    error: { code: 'lab-refused', expected: 'nothing', hint: 'this tool always refuses' },
  }),
);

export default defineFeature({
  title: 'ToolContribution',
  catalog: 'ToolContribution',
  kind: 'headless',
  summary:
    'defineTool pairs a realm-tagged descriptor with an executor; createToolRuntime lists/describes contributions and run() returns a ToolRun whose events stream ends in exactly one terminal.',
  expect:
    'list/describe expose both descriptors; a valid run succeeds with doubled=42 and events started/progress/terminal; invalid args give tool-invalid-args; a domain failure is wrapped as tool-domain-failed; bad ids and duplicate ids are rejected at definition time.',
  async run(checks) {
    const runtime = createToolRuntime([double, refuse]);
    checks.equal(
      'list ids',
      runtime
        .list()
        .map((d) => d.id)
        .join(','),
      'lab.double,lab.refuse',
    );
    checks.equal('describe realm', runtime.describe('lab.refuse')?.realm, 'engine');
    checks.equal('describe unknown', runtime.describe('lab.none'), undefined);

    const run = runtime.run(double, { value: 21 });
    const kinds: string[] = [];
    for await (const event of run.events) kinds.push(event.kind);
    const terminal = await run.terminal;
    checks.equal('run outcome', terminal.outcome, 'succeeded');
    checks.equal(
      'run result',
      terminal.outcome === 'succeeded' ? terminal.result.doubled : undefined,
      42,
    );
    checks.equal('event order', kinds.join(','), 'started,progress,terminal');
    checks.equal(
      'clean census',
      JSON.stringify(terminal.cleanup?.census),
      JSON.stringify({ worlds: 0, renderers: 0, canvases: 0, leases: 0 }),
    );
    checks.ok('timing recorded', (terminal.timing?.durationMs ?? -1) >= 0);

    const invalid = await runtime.run(double, { value: 'x' } as never).terminal;
    checks.equal(
      'invalid args code',
      invalid.outcome === 'failed' ? invalid.failure.code : 'succeeded',
      'tool-invalid-args',
    );
    const refused = await runtime.run(refuse, { value: 1 }).terminal;
    checks.equal(
      'domain failure code',
      refused.outcome === 'failed' ? refused.failure.code : 'succeeded',
      'tool-domain-failed',
    );
    checks.run('rejects unstable id', () => {
      try {
        defineTool({ ...double.descriptor, id: 'Bad Id' }, double.execute);
        return false;
      } catch (error) {
        return error instanceof TypeError ? error.message : false;
      }
    });
    checks.run('rejects duplicate ids', () => {
      try {
        createToolRuntime([double, double]);
        return false;
      } catch (error) {
        return error instanceof TypeError ? error.message : false;
      }
    });
  },
});
