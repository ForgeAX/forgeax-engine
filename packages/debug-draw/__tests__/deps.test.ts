import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  INITIAL_VERTEX_CAPACITY,
  MAX_VERTEX_CAPACITY,
  VERTEX_STRIDE_BYTES,
} from '../src/constants';

const PKG_JSON_PATH = resolve(import.meta.dirname, '../package.json');

function readPkgDeps(): string[] {
  const raw = readFileSync(PKG_JSON_PATH, 'utf-8');
  const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
  return Object.keys(pkg.dependencies ?? {});
}

describe('package dependency closure (AC-02)', () => {
  it('depends on the low-level vocabulary plus the RenderFeature plan contract', () => {
    const deps = readPkgDeps();
    const forgeaxDeps = deps.filter((d) => d.startsWith('@forgeax/'));
    expect(forgeaxDeps).toHaveLength(4);
    expect(forgeaxDeps).toContain('@forgeax/engine-render');
    expect(forgeaxDeps).toContain('@forgeax/engine-rhi');
    expect(forgeaxDeps).toContain('@forgeax/engine-math');
    expect(forgeaxDeps).toContain('@forgeax/engine-types');
  });

  it('does not depend on engine-ecs, engine-runtime, engine-render-graph, or engine-shader', () => {
    const deps = readPkgDeps();
    expect(deps).not.toContain('@forgeax/engine-ecs');
    expect(deps).not.toContain('@forgeax/engine-runtime');
    expect(deps).not.toContain('@forgeax/engine-render-graph');
    expect(deps).not.toContain('@forgeax/engine-shader');
  });
});

describe('constant values (AC-08 / AC-09)', () => {
  it('INITIAL_VERTEX_CAPACITY === 1024', () => {
    expect(INITIAL_VERTEX_CAPACITY).toBe(1024);
  });

  it('MAX_VERTEX_CAPACITY === 1_000_000', () => {
    expect(MAX_VERTEX_CAPACITY).toBe(1_000_000);
  });

  it('VERTEX_STRIDE_BYTES === 16', () => {
    expect(VERTEX_STRIDE_BYTES).toBe(16);
  });
});
