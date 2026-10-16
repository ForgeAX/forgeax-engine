import { beforeAll, describe, expect, it } from 'vitest';
import { compileShader } from '../index.js';
import { canonicalizePortableWgsl } from '../wgsl-compat.js';

describe('TAA resolve compiler contract', () => {
  let compileResult: Awaited<ReturnType<typeof compileShader>>;

  beforeAll(async () => {
    const fsId = 'node:fs';
    const pathId = 'node:path';
    const urlId = 'node:url';
    const fs = (await import(/* @vite-ignore */ fsId)) as {
      readFileSync(path: string, encoding: string): string;
    };
    const path = (await import(/* @vite-ignore */ pathId)) as {
      dirname(path: string): string;
      resolve(...paths: string[]): string;
    };
    const url = (await import(/* @vite-ignore */ urlId)) as {
      fileURLToPath(value: string): string;
    };
    const shaderRoot = path.resolve(
      path.dirname(url.fileURLToPath(import.meta.url)),
      '../../../shader/src',
    );
    const source = fs.readFileSync(path.resolve(shaderRoot, 'taa-resolve.wgsl'), 'utf8');
    const sceneTemporal = fs.readFileSync(path.resolve(shaderRoot, 'scene-temporal.wgsl'), 'utf8');
    const common = [
      '#define_import_path forgeax_view::common',
      'struct FullscreenOutput {',
      '  @builtin(position) position : vec4<f32>,',
      '  @location(0) uv : vec2<f32>,',
      '};',
      'fn fullscreen_triangle(vertexIndex : u32) -> FullscreenOutput {',
      '  var out : FullscreenOutput;',
      '  out.position = vec4<f32>(0.0);',
      '  out.uv = vec2<f32>(f32(vertexIndex));',
      '  return out;',
      '}',
    ].join('\n');
    compileResult = await compileShader(source, {
      id: path.resolve(shaderRoot, 'taa-resolve.wgsl'),
      imports: { 'forgeax_view::common': common, forgeax_scene_temporal: sceneTemporal },
    });
  });

  function compiledWgsl(): string {
    expect(compileResult.ok, compileResult.ok ? undefined : compileResult.error.message).toBe(true);
    if (!compileResult.ok) throw new Error(compileResult.error.message);
    return compileResult.value.wgsl;
  }

  it('composes and validates the shipped MRT resolve module', () => {
    expect(compileResult.ok, compileResult.ok ? undefined : compileResult.error.message).toBe(true);
  });

  it('retains the shipped TAA resolve entry point', () => {
    expect(compiledWgsl()).toContain('fn fs_main');
  });

  it('retains the sampled temporal history inputs', () => {
    expect(compiledWgsl()).toContain('historyTemporal');
    expect(compiledWgsl()).toContain('@location(0) color');
  });

  it('rewrites the Naga long-decimal TAA sentinel to scientific f32 notation', () => {
    const wgsl = canonicalizePortableWgsl('let taaSentinel = 100000000000000000000f;');
    expect(wgsl).toContain('1e20f');
    expect(wgsl).not.toContain('100000000000000000000f');
  });
});
