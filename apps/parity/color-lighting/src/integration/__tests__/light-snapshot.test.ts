import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

describe('direct light snapshot integration contract', () => {
  it('uses one normalized spot snapshot for both forward pipelines', async () => {
    const extract = await readSource('../../../../../../packages/render/src/render-system-extract.ts');
    const standardClusterShader = await readSource('../../../../../../packages/shader/src/standard-cluster.wgsl');

    expect(extract).toContain('direction: dirN');
    expect(standardClusterShader).not.toContain('normalize(light.direction.xyz)');
  });

  it('keeps the finite-range curve shared by the shader consumers', async () => {
    const punctualShader = await readSource('../../../../../../packages/shader/src/lighting-punctual.wgsl');
    const standardClusterShader = await readSource('../../../../../../packages/shader/src/standard-cluster.wgsl');

    expect(punctualShader).toContain('factor * factor');
    expect(standardClusterShader).toContain('factor * factor');
  });
});
