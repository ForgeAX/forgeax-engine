import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../host.ts', import.meta.url), 'utf8');
const start = source.indexOf('const gbufferBatchOrderDiagnostic = (() => {');
const end = source.indexOf('\n})();', start) + '\n})();'.length;
const evaluate = new Function(
  'query',
  `${source.slice(start, end)}\nreturn gbufferBatchOrderDiagnostic;`,
);
const parse = (values: Record<string, string>) => evaluate(new URLSearchParams(values));
describe('GBuffer diagnostic generated boot query', () => {
  it('omits the diagnostic by default and admits only explicit near/far audited JSON digests', () => {
    expect(start).toBeGreaterThan(0);
    expect(parse({})).toBeUndefined();
    for (const order of ['near', 'far'])
      expect(
        parse({
          'forgeax-gbuffer-order': order,
          'forgeax-gbuffer-program-digests': JSON.stringify([`sha256:${'b'.repeat(64)}`]),
        }),
      ).toEqual({ order, programDigests: [`sha256:${'b'.repeat(64)}`] });
    for (const values of [
      { 'forgeax-gbuffer-order': 'near' },
      { 'forgeax-gbuffer-program-digests': '[]' },
      { 'forgeax-gbuffer-order': 'off', 'forgeax-gbuffer-program-digests': '[]' },
      { 'forgeax-gbuffer-order': 'near', 'forgeax-gbuffer-program-digests': 'null' },
      { 'forgeax-gbuffer-order': 'near', 'forgeax-gbuffer-program-digests': '["not-a-sha"]' },
      {
        'forgeax-gbuffer-order': 'near',
        'forgeax-gbuffer-program-digests': JSON.stringify(
          Array(129).fill(`sha256:${'a'.repeat(64)}`),
        ),
      },
    ])
      expect(() => parse(values)).toThrow();
  });
  it('threads the parsed value into typed execution diagnostics while absent remains absent', () => {
    expect(source).toContain(
      '...(gbufferBatchOrderDiagnostic === undefined ? {} : { gbufferBatchOrderDiagnostic })',
    );
  });
});
