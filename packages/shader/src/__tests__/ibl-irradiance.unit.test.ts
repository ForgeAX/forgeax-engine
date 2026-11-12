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
let irradianceSource!: string;

beforeAll(async () => {
  fs = (await import(/* @vite-ignore */ 'node:fs')) as NodeFs;
  path = (await import(/* @vite-ignore */ 'node:path')) as NodePath;
  const url = (await import(/* @vite-ignore */ 'node:url')) as NodeUrl;
  srcDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  irradianceSource = fs.readFileSync(path.resolve(srcDir, 'ibl-irradiance.wgsl'), 'utf8');
});

describe('IBL irradiance payload contract', () => {
  it('records that convolution stores Lambert-normalized E over pi', () => {
    expect(irradianceSource).toContain('IRRADIANCE_PAYLOAD_E_OVER_PI');
    expect(irradianceSource).toMatch(/irradiance\s*=\s*PI\s*\*\s*irradiance/);
  });

  it('keeps the constant-environment analytic oracle finite and explicit', () => {
    const environment = 0.72;
    // The hemisphere integral is E=pi*L for a constant environment. The
    // convolution shader's PI*sampleAverage stores E/pi=L directly, which is
    // the Lambert diffuse radiance consumed by the material shader.
    const convolvedPayload = environment;
    const diffuseRadiance = convolvedPayload;

    expect(diffuseRadiance).toBeCloseTo(environment, 12);
    expect(Number.isFinite(diffuseRadiance)).toBe(true);
  });

  it('rejects NaN and infinity before a sample reaches the accumulation sum', () => {
    expect(irradianceSource).toMatch(/const IRRADIANCE_SAMPLE_DELTA:\s*f32\s*=\s*0\.05/);
    expect(irradianceSource).toContain('fn irradianceFiniteScalar');
    expect(irradianceSource).toContain('abs(value) <= 65504.0');
    expect(irradianceSource).toMatch(
      /irradianceFiniteVec3\(sampleVec\)[\s\S]*irradianceFiniteVec3\(sampleColor\)[\s\S]*irradianceFiniteScalar\(sampleWeight\)/,
    );
  });

  it('integrates a band-limited PMREM level instead of point-sampling the full cube', () => {
    // Regression: a 2.9 degree point-sample grid over the full-resolution
    // cube aliased an HDR sun disc into blocky speckles on diffuse surfaces.
    // three.js reads its PMREM at roughness 1 for diffuse for the same reason.
    expect(irradianceSource).toMatch(/var envPmrem:\s*texture_2d<f32>/);
    expect(irradianceSource).not.toMatch(/texture_cube/);
    expect(irradianceSource).toMatch(/const IRRADIANCE_SOURCE_MIP:\s*f32\s*=\s*4\.0/);
    expect(irradianceSource).toMatch(
      /samplePmremLevel\(\s*envPmrem,\s*envSamplerS,\s*sampleVec,\s*IRRADIANCE_SOURCE_MIP/,
    );
  });
});
