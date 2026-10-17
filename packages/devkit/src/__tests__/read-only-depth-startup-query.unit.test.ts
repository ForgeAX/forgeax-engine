import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../host.ts', import.meta.url), 'utf8');
const start = source.indexOf('const featureReadOnlyDepthBatchDiagnostic = (() => {');
const end = source.indexOf('\n})();', start) + '\n})();'.length;
const evaluate = new Function(
  'query',
  `${source.slice(start, end)}\nreturn featureReadOnlyDepthBatchDiagnostic;`,
);
const parse = (text: string) => evaluate(new URLSearchParams(text));
describe('generated read-only depth experiment startup query', () => {
  it('defaults absent and preserves explicit off/on booleans', () => {
    expect(start).toBeGreaterThan(0);
    expect(parse('')).toBeUndefined();
    expect(parse('forgeax-feature-read-only-depth-batch=0')).toBe(false);
    expect(parse('forgeax-feature-read-only-depth-batch=1')).toBe(true);
  });
  it.each([
    '',
    'true',
    'false',
    '2',
    '-1',
    '01',
    ' 1',
  ])('rejects noncanonical value %j', (value) => {
    expect(() =>
      parse(new URLSearchParams({ 'forgeax-feature-read-only-depth-batch': value }).toString()),
    ).toThrow();
  });
  it('rejects ambiguous repeated query entries', () => {
    expect(() =>
      parse('forgeax-feature-read-only-depth-batch=0&forgeax-feature-read-only-depth-batch=1'),
    ).toThrow();
  });
  it('uses the same parsed boolean for typed Worker diagnostics and ordinary Renderer profile', () => {
    const spread =
      '...(featureReadOnlyDepthBatchDiagnostic === undefined ? {} : { featureReadOnlyDepthBatchDiagnostic })';
    expect(source.split(spread)).toHaveLength(3);
    expect(source).toContain(
      'if (!workerExecution && (gbufferBatchOrderDiagnostic !== undefined || featureReadOnlyDepthBatchDiagnostic !== undefined))',
    );
    expect(source).toContain('app.renderer.setProfile({ ...app.renderer.inspect().profile,');
  });
});
