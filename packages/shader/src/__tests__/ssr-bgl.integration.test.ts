import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEPTH_PYRAMID_SHADER_MODULES, SSR_SHADER_MODULES } from '../index.js';

interface CompileValue {
  readonly bindings: readonly Readonly<Record<string, unknown>>[];
  readonly manifestEntry: { readonly hash: string; readonly bindings: string };
}

interface CompileResult {
  readonly ok: boolean;
  readonly value?: CompileValue;
  readonly error?: { readonly code: string; readonly message: string };
}

interface CompilerModule {
  compileShader(
    source: string,
    options: { readonly id: string; readonly imports?: Readonly<Record<string, string>> },
  ): Promise<CompileResult>;
}

const SOURCES = {
  pyramidSeed: readFileSync(resolve(import.meta.dirname, '../depth-pyramid-seed.wgsl'), 'utf8'),
  pyramidReduce: readFileSync(resolve(import.meta.dirname, '../depth-pyramid-reduce.wgsl'), 'utf8'),
  trace: readFileSync(resolve(import.meta.dirname, '../ssr-trace.wgsl'), 'utf8'),
  temporal: readFileSync(resolve(import.meta.dirname, '../ssr-temporal.wgsl'), 'utf8'),
} as const;
const GBUFFER = readFileSync(resolve(import.meta.dirname, '../standard-gbuffer.wgsl'), 'utf8');
const COMMON = readFileSync(resolve(import.meta.dirname, '../common.wgsl'), 'utf8');

let compiler: CompilerModule;

beforeAll(async () => {
  compiler = (await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  )) as unknown as CompilerModule;
});

async function compile(name: keyof typeof SOURCES): Promise<CompileValue> {
  const result = await compiler.compileShader(SOURCES[name], {
    id: `forgeax_ssr::${name}`,
    imports: {
      'forgeax_view::common': COMMON,
      'forgeax_pbr::gbuffer': GBUFFER,
      'forgeax_depth_pyramid::sample': readFileSync(
        resolve(import.meta.dirname, '../depth-pyramid-sample.wgsl'),
        'utf8',
      ),
    },
  });
  expect(result.ok, result.ok ? undefined : result.error?.message).toBe(true);
  if (!result.ok || result.value === undefined) throw new Error(`failed to compile ${name}`);
  return result.value;
}

function entries(value: CompileValue): readonly Readonly<Record<string, unknown>>[] {
  const group = value.bindings[0];
  expect(group).toBeDefined();
  if (group === undefined || !Array.isArray(group.entries)) throw new Error('missing group zero');
  return group.entries as readonly Readonly<Record<string, unknown>>[];
}

function storageTexture(
  entry: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  expect(entry?.storageTexture).toBeDefined();
  if (
    entry === undefined ||
    typeof entry.storageTexture !== 'object' ||
    entry.storageTexture === null
  ) {
    throw new Error('missing storage texture binding');
  }
  return entry.storageTexture as Readonly<Record<string, unknown>>;
}

describe('SSR built-in shader binding contract', () => {
  it('reflects the depth pyramid seed as depth inputs plus r32float storage output', async () => {
    const value = await compile('pyramidSeed');
    const reflected = entries(value);
    expect(reflected).toHaveLength(4);
    expect(reflected[0]).toMatchObject({
      binding: 0,
      texture: { sampleType: 'depth', viewDimension: '2d' },
    });
    expect(storageTexture(reflected[1])).toMatchObject({
      access: 'write-only',
      format: 'r32float',
      viewDimension: '2d',
    });
    expect(reflected[2]).toMatchObject({ binding: 2, buffer: { type: 'uniform' } });
    expect(reflected[3]).toMatchObject({
      binding: 3,
      texture: { sampleType: 'depth', viewDimension: '2d', multisampled: true },
    });
    expect(JSON.parse(value.manifestEntry.bindings)).toEqual(value.bindings);
  });

  it('reflects trace inputs including lighting-owned coverage and the shared View', async () => {
    const value = await compile('trace');
    const reflected = entries(value);
    expect(reflected).toHaveLength(9);
    for (let binding = 0; binding < 4; binding += 1) {
      expect(reflected[binding]).toMatchObject({
        binding,
        texture: {
          sampleType: binding === 0 ? 'depth' : binding === 1 ? 'uint' : 'unfilterable-float',
          viewDimension: '2d',
        },
      });
    }
    expect(storageTexture(reflected[4])).toMatchObject({
      access: 'write-only',
      format: 'rgba16float',
      viewDimension: '2d',
    });
    expect(reflected[5]).toMatchObject({ binding: 5, buffer: { type: 'uniform' } });
    expect(reflected[7]).toMatchObject({
      binding: 7,
      texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
    });
    expect(reflected[8]).toMatchObject({
      binding: 8,
      storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' },
    });
  });

  it('reflects depth pyramid reduction as an r32float sampled input plus storage output', async () => {
    const value = await compile('pyramidReduce');
    const reflected = entries(value);
    expect(reflected).toHaveLength(2);
    expect(reflected[0]).toMatchObject({
      binding: 0,
      texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
    });
    expect(storageTexture(reflected[1])).toMatchObject({
      access: 'write-only',
      format: 'r32float',
      viewDimension: '2d',
    });
  });

  it('reflects temporal resolve with packed actual normal and confidence history', async () => {
    const value = await compile('temporal');
    const reflected = entries(value);
    expect(reflected).toHaveLength(12);
    expect(reflected[11]).toMatchObject({
      binding: 11,
      texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
    });
    expect(reflected[9]).toMatchObject({
      binding: 9,
      texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
    });
    expect(reflected[10]).toMatchObject({
      binding: 10,
      storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
    });
    expect(reflected[8]).toMatchObject({ binding: 8, buffer: { type: 'uniform' } });
    for (let binding = 0; binding < 5; binding += 1) {
      expect(reflected[binding]).toMatchObject({
        binding,
        texture: {
          sampleType: binding === 1 ? 'depth' : binding === 2 ? 'uint' : 'unfilterable-float',
          viewDimension: '2d',
        },
      });
    }
    expect(storageTexture(reflected[5])).toMatchObject({
      access: 'write-only',
      format: 'rgba16float',
      viewDimension: '2d',
    });
    expect(reflected[6]).toMatchObject({ binding: 6, buffer: { type: 'uniform' } });
    expect(storageTexture(reflected[7])).toMatchObject({
      access: 'write-only',
      format: 'rgba16float',
      viewDimension: '2d',
    });
  });

  it('requires a registry-discoverable stable module id for each artifact', () => {
    const registrySource = readFileSync(
      resolve(import.meta.dirname, '../ShaderRegistry.ts'),
      'utf8',
    );
    expect(registrySource).toContain('SSR_SHADER_MODULES');
    expect(DEPTH_PYRAMID_SHADER_MODULES).toEqual({
      seed: 'forgeax_depth_pyramid::seed',
      reduce: 'forgeax_depth_pyramid::reduce',
    });
    expect(SSR_SHADER_MODULES).toEqual({
      trace: 'forgeax_ssr::trace',
      temporal: 'forgeax_ssr::temporal',
    });
  });
});
