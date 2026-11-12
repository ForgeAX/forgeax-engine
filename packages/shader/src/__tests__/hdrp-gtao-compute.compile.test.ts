import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

interface CompileResult {
  readonly ok: boolean;
  readonly value?: {
    readonly wgsl: string;
    readonly bindings: readonly {
      readonly group: number;
      readonly entries: readonly {
        readonly binding: number;
        readonly visibility: number;
        readonly resource: Readonly<Record<string, unknown>>;
      }[];
    }[];
  };
  readonly error?: { readonly message: string };
}

interface ShaderCompiler {
  compileShader(
    source: string,
    options: {
      readonly id: string;
      readonly imports: Readonly<Record<string, string>>;
      readonly computeEntry: string;
    },
  ): Promise<CompileResult>;
}

const source = readFileSync(resolve(import.meta.dirname, '../hdrp-gtao-compute.wgsl'), 'utf8');
const ssao = readFileSync(resolve(import.meta.dirname, '../hdrp-ssao.wgsl'), 'utf8');
const gbuffer = readFileSync(resolve(import.meta.dirname, '../standard-gbuffer.wgsl'), 'utf8');
const common = readFileSync(resolve(import.meta.dirname, '../common.wgsl'), 'utf8');
let compiler: ShaderCompiler;

beforeAll(async () => {
  compiler = (await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  )) as unknown as ShaderCompiler;
});

describe('GTAO compute specialization', () => {
  it('retains the shared raw evaluator and only its compute-visible inputs', async () => {
    const compiled = await compiler.compileShader(source, {
      id: 'forgeax_hdrp::gtao_compute',
      imports: {
        'forgeax_hdrp::ssao': ssao,
        'forgeax_pbr::gbuffer': gbuffer,
        'forgeax_view::common': common,
      },
      computeEntry: 'cs_gtao_calc',
    });
    expect(compiled.ok, compiled.ok ? '' : compiled.error?.message).toBe(true);
    if (!compiled.ok || compiled.value === undefined) return;
    expect(compiled.value.wgsl).toContain('fn gtaoRawVisibility');
    expect(compiled.value.wgsl).toContain('textureStore(gtao_output');
    expect(compiled.value.wgsl).not.toContain('fn fs_ssao_calc');
    expect(
      compiled.value.bindings
        .flatMap((group) => group.entries.map(({ binding }) => binding))
        .sort(),
    ).toEqual([0, 4, 5, 9]);
  });
});
