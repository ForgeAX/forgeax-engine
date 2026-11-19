import { expect, it, vi } from 'vitest';

const phases = vi.hoisted(() => ({ parse: 0 }));
vi.mock('@forgeax/engine-naga', async (load) => {
  const actual = await load<typeof import('@forgeax/engine-naga')>();
  return {
    ...actual,
    prepareNagaCompiler: async () => {
      const ready = await actual.prepareNagaCompiler();
      if (!ready.ok) return ready;
      const native = ready.value;
      return actual.ok({
        ...native,
        parse: (...args: Parameters<typeof native.parse>) => {
          phases.parse++;
          return native.parse(...args);
        },
      });
    },
  };
});

import { prepareShaderCompiler } from '../program.js';

it('reflects the checked composed IR without parsing the same final WGSL again', async () => {
  const compiler = (await prepareShaderCompiler()).unwrap();
  const before = phases.parse;
  const result = compiler.compile('@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }');
  expect(result.ok).toBe(true);
  expect(result.unwrap().reflection?.entryPoints).toEqual([
    expect.objectContaining({ name: 'fs', stage: 'fragment' }),
  ]);
  expect(phases.parse - before).toBe(0);
});

it('normalizes long f32 literals before final IR admission without a second parse', async () => {
  const compiler = (await prepareShaderCompiler()).unwrap();
  const before = phases.parse;
  const result = compiler
    .compile('@fragment fn fs() -> @location(0) vec4f { return vec4f(100000000000000000000f); }')
    .unwrap();
  expect(result.wgsl).toMatch(/e20f/);
  expect(result.wgsl).not.toMatch(/[1-9][0-9]{19,}f/);
  expect(phases.parse - before).toBe(0);
});
