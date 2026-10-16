import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (name: string): string =>
  readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('render consumes geometry layout projection', () => {
  it('does not retain the legacy stride discriminator or uv count as layout authority', () => {
    const renderData = source('render-data.ts');
    const store = source('device/gpu-residency.ts');
    const pipeline = source('pipeline-spec.ts');

    expect(renderData).toMatch(/VertexLayoutProjection/);
    expect(store).toMatch(/VertexLayoutProjection/);
    expect(pipeline).toMatch(/VertexLayoutProjection/);
    expect(renderData).toMatch(/deriveVertexLayoutProjection/);
    expect(store).toMatch(/layoutProjection\.arrayStride/);
  });

  it('routes GPU layout construction through the geometry owner', () => {
    const pipeline = source('pipeline-spec.ts');
    expect(pipeline).toMatch(/deriveVertexLayoutProjection/);
    expect(pipeline).not.toMatch(/function vertexLayoutDigest/);
  });
});
