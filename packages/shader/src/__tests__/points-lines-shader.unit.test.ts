import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../points-lines.wgsl', import.meta.url)),
  'utf8',
);

describe('points-lines triangle expansion shader contract', () => {
  it('declares one engine-owned material module and physical viewport input', () => {
    expect(source).toContain('#define_import_path forgeax_material::points_lines');
    expect(source).toContain('struct PointsLinesView');
    expect(source).toContain('physicalViewport');
    expect(source).toContain('model : mat4x4<f32>');
    expect(source).toContain('pointsLinesView.model');
    expect(source).toMatch(/@group\(0\)\s*@binding\(10\)\s+var<uniform>\s+pointsLinesView/);
  });

  it('expands square and circle points from clip-space pixel deltas', () => {
    expect(source).toContain('fn expandPoint');
    expect(source).toContain('sizePx');
    expect(source).toContain('square');
    expect(source).toContain('circleCoverage');
    expect(source).toContain('sampleCenter');
    expect(source).toContain('physicalViewport');
  });

  it('expands each butt segment independently without native wide primitive state', () => {
    expect(source).toContain('fn expandLine');
    expect(source).toContain('width');
    expect(source).toContain('butt');
    expect(source).toContain('line-list');
    expect(source).not.toMatch(/pointSize|lineWidth/);
    expect(source).not.toContain('primitive-wide');
  });

  it('keeps the portable source free of compute and runtime compiler dependencies', () => {
    expect(source).not.toMatch(/@compute|var<storage>|storage-read|indirect/);
    expect(source).not.toMatch(/engine-(?:naga|shader-compiler|wgpu-wasm)/);
    expect(source).not.toMatch(/fn\s+(?:compile|compose|reflect)/);
  });
});
