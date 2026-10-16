import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';

const ownerSource = readFileSync(new URL('../gpu-texture-usage.ts', import.meta.url), 'utf8');
const consumerSources = [
  readFileSync(new URL('../render-data.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../shadow-atlas.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../ssao-buffers.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../device/gpu-residency.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../ibl/IblPipelineCache.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../ibl/skylight-bind-group.ts', import.meta.url), 'utf8'),
];

describe('texture usage owner', () => {
  it('keeps the five texture usage bits in one owner', () => {
    expect(GPU_TEXTURE_USAGE_COPY_SRC).toBe(0x01);
    expect(GPU_TEXTURE_USAGE_COPY_DST).toBe(0x02);
    expect(GPU_TEXTURE_USAGE_TEXTURE_BINDING).toBe(0x04);
    expect(GPU_TEXTURE_USAGE_STORAGE_BINDING).toBe(0x08);
    expect(GPU_TEXTURE_USAGE_RENDER_ATTACHMENT).toBe(0x10);
    expect(GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING).toBe(0x14);
    expect(ownerSource.match(/export const GPU_TEXTURE_USAGE_/g)).toHaveLength(6);
  });

  it('routes texture usage consumers through the owner', () => {
    for (const source of consumerSources) {
      expect(source).toContain('gpu-texture-usage');
      expect(source).not.toMatch(/const GPU_TEXTURE_USAGE_[A-Z_]+\s*=/);
      expect(source).not.toMatch(
        /const (TEXTURE_BINDING_USAGE|TEXTURE_COPY_DST_USAGE|TEXTURE_COPY_SRC_USAGE|RENDER_ATTACHMENT_USAGE)\s*=/,
      );
      expect(source).not.toMatch(
        /GPU_TEXTURE_USAGE_(RENDER_ATTACHMENT|TEXTURE_BINDING)\s*\|\s*GPU_TEXTURE_USAGE_(RENDER_ATTACHMENT|TEXTURE_BINDING)/,
      );
    }
  });

  it('keeps typed pipelines on graph access declarations instead of physical usage bits', async () => {
    const graphOwners = await Promise.all([
      readFileSync(new URL('../pipeline/standard-forward-lane.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../pipeline/standard-pipeline.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../typed-shadow-passes.ts', import.meta.url), 'utf8'),
    ]);
    for (const source of graphOwners) {
      expect(source).not.toMatch(/usage:\s*0x[0-9a-f]+/i);
    }
    expect(graphOwners.join('\n')).toMatch(
      /usage: '(?:color-attachment|depth-stencil-write|storage-write)'/,
    );
    expect(graphOwners[2]).toContain('gpu-texture-usage');
  });
});
