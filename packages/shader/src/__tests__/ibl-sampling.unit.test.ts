import { beforeAll, describe, expect, it } from 'vitest';

interface NodeFs {
  readFileSync: (path: string, encoding: string) => string;
}

interface NodePath {
  resolve: (...parts: string[]) => string;
  dirname: (path: string) => string;
}

interface NodeUrl {
  fileURLToPath: (url: string) => string;
}

let fs!: NodeFs;
let path!: NodePath;
let srcDir!: string;
let samplingSource!: string;

beforeAll(async () => {
  fs = (await import(/* @vite-ignore */ 'node:fs')) as NodeFs;
  path = (await import(/* @vite-ignore */ 'node:path')) as NodePath;
  const url = (await import(/* @vite-ignore */ 'node:url')) as NodeUrl;
  srcDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  samplingSource = fs.readFileSync(path.resolve(srcDir, 'ibl-sampling.wgsl'), 'utf8');
});

describe('IBL diffuse sampling payload contract', () => {
  it('names the sampled payload as E over pi at the canonical sampling owner', () => {
    expect(samplingSource).toContain('irradianceEOverPi');
    expect(samplingSource).toMatch(/return\s+irradianceEOverPi\s*;/);
  });

  it('does not divide the already Lambert-normalized diffuse payload again', () => {
    const diffuseBody = samplingSource.match(/fn sampleIblDiffuse\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(diffuseBody).not.toMatch(/\/\s*PI/);
  });
});
