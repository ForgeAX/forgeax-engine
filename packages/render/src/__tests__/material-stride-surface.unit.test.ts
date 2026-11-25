import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MATERIAL_PER_ENTITY_STRIDE } from './render-system-driver';

const ownerSource = readFileSync(new URL('../record/render-context.ts', import.meta.url), 'utf8');
const rendererFactorySource = readFileSync(
  new URL('../assembly/webgpu-ready-resources.ts', import.meta.url),
  'utf8',
);
// The physical uniform write resolves every draw's dynamic offset; pass recorders
// consume its result and never see the stride. Consumers of the stride itself:
const strideConsumers = [
  readFileSync(new URL('../record/material-uniforms.ts', import.meta.url), 'utf8'),
  rendererFactorySource,
];
const recordSources = [
  ...strideConsumers,
  readFileSync(new URL('../record/main-pass.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../record/main-pass-material.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../record/shadow-pass.ts', import.meta.url), 'utf8'),
];

describe('material dynamic-offset stride surface', () => {
  it('keeps one internal owner and routes every record path through it', () => {
    expect(MATERIAL_PER_ENTITY_STRIDE).toBe(1792);
    expect(
      ownerSource.match(
        /export const MATERIAL_PER_ENTITY_STRIDE\s*=\s*Math\.ceil\(MATERIAL_UNIFORM_BYTES \/ 256\) \* 256/g,
      ),
    ).toHaveLength(1);

    for (const source of strideConsumers) expect(source).toContain('MATERIAL_PER_ENTITY_STRIDE');
    for (const source of recordSources)
      expect(source).not.toMatch(/const MATERIAL_PER_ENTITY_STRIDE\s*=/);
  });

  it('routes shared renderer allocation through the owner', () => {
    expect(rendererFactorySource).toContain('materialStride: MATERIAL_PER_ENTITY_STRIDE');
    expect(rendererFactorySource).not.toMatch(/const PER_ENTITY_STRIDE\s*=/);
  });
});
