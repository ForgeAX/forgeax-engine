import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handles = vi.hoisted(() => ({
  parsed: [] as Array<{ free: ReturnType<typeof vi.fn> }>,
  validated: [] as Array<{ free: ReturnType<typeof vi.fn> }>,
}));

vi.mock('@forgeax/engine-naga', async (original) => {
  const actual = await original<typeof import('@forgeax/engine-naga')>();
  return {
    ...actual,
    parse: async (...args: Parameters<typeof actual.parse>) => {
      const result = await actual.parse(...args);
      if (result.ok) {
        const module = result.value as { free(): void };
        handles.parsed.push({ free: vi.spyOn(module, 'free') });
      }
      return result;
    },
    validate: async (...args: Parameters<typeof actual.validate>) => {
      const result = await actual.validate(...args);
      if (result.ok) {
        const module = result.value as { free(): void };
        handles.validated.push({ free: vi.spyOn(module, 'free') });
      }
      return result;
    },
  };
});

import { compileShader } from '../compile.js';

const source = `
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
`;

beforeEach(() => {
  handles.parsed.length = 0;
  handles.validated.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('real Naga compiler handle lifetime', () => {
  it('releases validated IR before successful compilation returns', async () => {
    const result = await compileShader(source);
    expect(result.ok).toBe(true);
    expect(handles.validated).toHaveLength(1);
    expect(handles.validated[0]?.free).toHaveBeenCalledTimes(1);
    // Validation consumes its parsed handle; freeing it again would double-free.
    expect(handles.parsed[0]?.free).not.toHaveBeenCalled();
  });

  it('releases validated IR when selected-entry validation rejects the program', async () => {
    const result = await compileShader(source, {
      renderEntries: {
        vertex: 'missing_vertex',
        fragment: 'fs_main',
        colorFormats: ['rgba8unorm'],
      },
    });
    expect(result.ok).toBe(false);
    expect(handles.validated).toHaveLength(1);
    expect(handles.validated[0]?.free).toHaveBeenCalledTimes(1);
  });

  it('releases successful syntax-probe IR before reporting a bad import', async () => {
    const entry = source.replace('vec4<f32>(0.0)', 'vec4<f32>(good() + bad())');
    const result = await compileShader(
      `#import lifetime::good::{ good }\n#import lifetime::bad::{ bad }\n${entry}`,
      {
        imports: {
          'lifetime::good': '#define_import_path lifetime::good\nfn good() -> f32 { return 1.0; }',
          'lifetime::bad': '#define_import_path lifetime::bad\nfn bad( { }',
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(handles.validated).toHaveLength(0);
    expect(handles.parsed.length).toBeGreaterThan(0);
    for (const module of handles.parsed) expect(module.free).toHaveBeenCalledTimes(1);
  });
});
