import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const spotSource = readFileSync(new URL('../components/spot-light.ts', import.meta.url), 'utf8');
const errorSource = readFileSync(new URL('../errors/render.ts', import.meta.url), 'utf8');

describe('SpotLight projector contract', () => {
  it('exposes an optional GUID-backed TextureAsset projector field', () => {
    expect(spotSource).toMatch(/projector\??:/);
    expect(spotSource).toMatch(/TextureAsset/);
    expect(spotSource).not.toContain('whiteTexture');
    expect(spotSource).not.toContain('cookieRegistry');
  });

  it('distinguishes absent projector from authored failure', () => {
    expect(spotSource).toContain('absent');
    expect(errorSource).toMatch(/projector/);
    expect(errorSource).toMatch(/expected/);
    expect(errorSource).toMatch(/hint/);
    expect(errorSource).toMatch(/detail/);
  });
});
