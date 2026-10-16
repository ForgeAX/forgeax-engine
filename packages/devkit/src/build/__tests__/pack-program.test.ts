import { loadPackProgram } from '@forgeax/engine-pack/runtime';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { preparePackProgramSource, prepareRuntimePackProgram } from '../../plugin-build.js';

vi.mock('typescript', async (original) => {
  const actual = await original<{ default: typeof ts }>();
  return {
    ...actual,
    default: { ...actual.default, transpileModule: vi.fn(actual.default.transpileModule) },
  };
});

describe('runtime program source preparation', () => {
  beforeEach(() => {
    vi.mocked(ts.transpileModule).mockClear();
  });

  it('runs a new JS generator and plugin with zero compiler calls', async () => {
    const program = preparePackProgramSource({
      entry: 'main.js',
      export: 'build',
      modules: {
        'main.js':
          'export function build(size) { return size * 3; } export const plugin = { apply(ctx) { ctx.value = 42; } };',
      },
    }).unwrap();
    const build = (await loadPackProgram(program)).unwrap() as (size: number) => number;
    expect(build(7)).toBe(21);
    const preparedPlugin = preparePackProgramSource({
      entry: program.entry,
      export: 'plugin',
      modules: program.modules,
    }).unwrap();
    const context = { value: 0 };
    const plugin = (await loadPackProgram(preparedPlugin)).unwrap() as {
      apply(ctx: typeof context): void;
    };
    plugin.apply(context);
    expect(context.value).toBe(42);
    expect(ts.transpileModule).not.toHaveBeenCalled();
  });

  it('actually converts typed modules and restores their JS without another compiler call', async () => {
    const program = preparePackProgramSource({
      entry: 'main.ts',
      export: 'build',
      modules: {
        'main.ts':
          "import { multiplier } from './helper.ts'; export function build(size: number): number { return multiplier * size; }",
        'helper.ts': 'export const multiplier: number = 4;',
      },
    }).unwrap();
    expect(ts.transpileModule).toHaveBeenCalledTimes(2);
    expect(program.entry).toBe('main.js');
    expect(program.modules['main.js']).not.toContain('size: number');
    vi.mocked(ts.transpileModule).mockClear();
    const restored = JSON.parse(JSON.stringify(program));
    const build = (await loadPackProgram(restored)).unwrap() as (size: number) => number;
    expect(build(8)).toBe(32);
    expect(ts.transpileModule).not.toHaveBeenCalled();
  });

  it('retains compiler errors and rejects colliding emitted paths', () => {
    expect(
      preparePackProgramSource({
        entry: 'bad.ts',
        export: 'default',
        modules: { 'bad.ts': 'export const = ;' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'pack-program-invalid' } });
    expect(
      preparePackProgramSource({
        entry: 'a.ts',
        export: 'default',
        modules: { 'a.ts': 'export default 1;', 'a.js': 'export default 2;' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'pack-program-invalid' } });
  });

  it('saves TS originals by value and restores a typed plugin from JS only', async () => {
    const source = {
      entry: 'behavior.mts',
      export: 'default',
      modules: {
        'behavior.mts': 'export default { apply(ctx: { value: number }) { ctx.value += 11; } };',
      },
    };
    const prepared = prepareRuntimePackProgram(source).unwrap();
    expect(prepared.source).toEqual(source);
    source.modules['behavior.mts'] = 'invalid';
    expect(prepared.source?.modules['behavior.mts']).toContain('ctx.value += 11');
    const saved = JSON.parse(JSON.stringify(prepared));
    vi.mocked(ts.transpileModule).mockClear();
    const plugin = (await loadPackProgram(saved.artifact)).unwrap() as {
      apply(ctx: { value: number }): void;
    };
    const context = { value: 4 };
    plugin.apply(context);
    expect(context.value).toBe(15);
    expect(ts.transpileModule).not.toHaveBeenCalled();
    const js = prepareRuntimePackProgram({
      entry: 'plain.js',
      export: 'default',
      modules: { 'plain.js': 'export default 1;' },
    }).unwrap();
    expect(js.source).toBeUndefined();
    expect(js.artifact.modules['plain.js']).toBe('export default 1;');
  });
});
