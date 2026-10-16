import { describe, expect, it } from 'vitest';
import { createToolRuntime, defineTool, type SnapshotRef } from '../../src/index.js';

const schema = {
  parse(value: unknown) {
    return typeof value === 'number'
      ? { ok: true as const, value }
      : { ok: false as const, error: 'expected a number' };
  },
};

describe('ordinary TypeScript ToolRun composition', () => {
  it('keeps parent lineage and explicitly passes snapshotAfter', async () => {
    const authored: SnapshotRef = { revision: 2, digest: 'sha256:authored' };
    const author = defineTool(
      {
        id: 'test.author',
        title: 'Author',
        summary: 'Produces an authority revision.',
        realm: 'build',
        argsSchema: schema,
        resultSchema: schema,
        evidence: [],
      },
      async (value) => ({ ok: true as const, value: value + 1, snapshotAfter: authored, artifacts: [] }),
    );
    const build = defineTool(
      {
        id: 'test.build',
        title: 'Build',
        summary: 'Consumes the explicit revision.',
        realm: 'build',
        argsSchema: schema,
        resultSchema: schema,
        evidence: [],
      },
      async (value, context) => {
        expect(context.snapshot).toEqual(authored);
        return value + 1;
      },
    );
    const runtime = createToolRuntime([author, build]);
    const authoredRun = runtime.run(author, 1);
    const authoredTerminal = await authoredRun.terminal;
    expect(authoredTerminal.outcome).toBe('succeeded');
    if (authoredTerminal.outcome !== 'succeeded') return;
    const builtTerminal = await runtime.run(build, authoredTerminal.result, {
      snapshot: authoredTerminal.snapshotAfter,
    }).terminal;
    expect(builtTerminal.outcome).toBe('succeeded');
  });
});
