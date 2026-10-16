import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_INDIRECT,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';

const ownerSource = readFileSync(new URL('../gpu-usage.ts', import.meta.url), 'utf8');
const meshSsboSource = readFileSync(new URL('../record/mesh-ssbo.ts', import.meta.url), 'utf8');
const rendererFactorySource = readFileSync(
  new URL('../assembly/webgpu-ready.ts', import.meta.url),
  'utf8',
);
const consumerSources = [
  readFileSync(new URL('../render-data.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../device/gpu-residency.ts', import.meta.url), 'utf8'),
  rendererFactorySource,
];
const featureBufferSources = [
  {
    source: readFileSync(new URL('../record/target-capture-lighting.ts', import.meta.url), 'utf8'),
    names: ['GPU_BUFFER_USAGE_UNIFORM', 'GPU_BUFFER_USAGE_COPY_DST'],
  },
  {
    source: readFileSync(new URL('../hdrp-buffers.ts', import.meta.url), 'utf8'),
    names: ['GPU_BUFFER_USAGE_UNIFORM', 'GPU_BUFFER_USAGE_STORAGE', 'GPU_BUFFER_USAGE_COPY_DST'],
  },
  {
    source: readFileSync(new URL('../ssao-buffers.ts', import.meta.url), 'utf8'),
    names: ['GPU_BUFFER_USAGE_UNIFORM', 'GPU_BUFFER_USAGE_COPY_DST'],
  },
  {
    source: readFileSync(new URL('../device/gpu-residency.ts', import.meta.url), 'utf8'),
    names: ['GPU_BUFFER_USAGE_UNIFORM', 'GPU_BUFFER_USAGE_COPY_DST'],
  },
  {
    source: readFileSync(new URL('../ibl/skylight-bind-group.ts', import.meta.url), 'utf8'),
    names: ['GPU_BUFFER_USAGE_UNIFORM', 'GPU_BUFFER_USAGE_COPY_DST'],
  },
  {
    source: readFileSync(new URL('../record/main-pass-geometry.ts', import.meta.url), 'utf8'),
    names: ['GPU_BUFFER_USAGE_STORAGE', 'GPU_BUFFER_USAGE_UNIFORM', 'GPU_BUFFER_USAGE_COPY_DST'],
  },
  {
    source: readFileSync(new URL('../record/main-pass-sprite-draws.ts', import.meta.url), 'utf8'),
    names: ['GPU_BUFFER_USAGE_STORAGE', 'GPU_BUFFER_USAGE_UNIFORM', 'GPU_BUFFER_USAGE_COPY_DST'],
  },
  {
    source: readFileSync(new URL('../systems/skin-palette-allocator.ts', import.meta.url), 'utf8'),
    names: ['GPU_BUFFER_USAGE_STORAGE', 'GPU_BUFFER_USAGE_UNIFORM', 'GPU_BUFFER_USAGE_COPY_DST'],
  },
  {
    source: readFileSync(new URL('../assembly/post-process-params.ts', import.meta.url), 'utf8'),
    names: ['GPU_BUFFER_USAGE_UNIFORM', 'GPU_BUFFER_USAGE_COPY_DST'],
  },
];

describe('render buffer usage owner', () => {
  it('keeps the render buffer bits in one owner', () => {
    expect(GPU_BUFFER_USAGE_VERTEX).toBe(0x20);
    expect(GPU_BUFFER_USAGE_INDEX).toBe(0x10);
    expect(GPU_BUFFER_USAGE_COPY_DST).toBe(0x08);
    expect(GPU_BUFFER_USAGE_COPY_SRC).toBe(0x04);
    expect(GPU_BUFFER_USAGE_INDIRECT).toBe(0x100);
    expect(GPU_BUFFER_USAGE_UNIFORM).toBe(0x40);
    expect(GPU_BUFFER_USAGE_STORAGE).toBe(0x80);
    expect(GPU_BUFFER_USAGE_MAP_READ).toBe(0x01);
    expect(ownerSource.match(/export const GPU_BUFFER_USAGE_/g)).toHaveLength(9);
  });

  it('routes mesh descriptor, update, and bootstrap consumers through the owner', () => {
    for (const source of consumerSources) {
      expect(source).toContain('GPU_BUFFER_USAGE_VERTEX');
      expect(source).toContain('GPU_BUFFER_USAGE_INDEX');
      expect(source).toContain('GPU_BUFFER_USAGE_COPY_DST');
      expect(source).not.toMatch(/const GPU_BUFFER_USAGE_(VERTEX|INDEX|COPY_DST)\s*=/);
      expect(source).not.toMatch(/usage:\s*0x[0-9a-f]+/i);
    }
  });

  it('routes feature-local buffer consumers through the owner', () => {
    for (const { source, names } of featureBufferSources) {
      for (const name of names) {
        expect(source).toContain(name);
        expect(source).not.toMatch(new RegExp(`const ${name}\\s*=`));
      }
    }
  });

  it('keeps shadow-depth readback out of the renderer factory', () => {
    expect(rendererFactorySource).not.toContain('GPU_BUFFER_USAGE_MAP_READ');
    expect(rendererFactorySource).not.toMatch(/const (COPY_DST|MAP_READ)\s*=\s*0x/);
  });

  it('removes the record cluster buffer usage aliases', () => {
    expect(meshSsboSource).not.toMatch(
      /export const (STORAGE_USAGE|UNIFORM_USAGE|COPY_DST_USAGE)\s*=/,
    );
  });
});
