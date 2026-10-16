import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const main = readFileSync(
  new URL('../../../../apps/hello/volumetric-fog/src/main.ts', import.meta.url),
  'utf8',
);
const smoke = readFileSync(
  new URL('../../../../apps/hello/volumetric-fog/scripts/smoke-browser.mjs', import.meta.url),
  'utf8',
);

describe('volumetric fog Spot closure', () => {
  it('uses exactly one real SpotLight as the VolumetricFog source', () => {
    expect(main).toContain('spawnVolumetricSpot');
    expect(main).toContain('light: selectedLight');
    expect(main).not.toContain('component: DirectionalLight');
  });

  it('keeps browser cases on the real renderer and includes shadow falsifiers', () => {
    expect(smoke).toContain('diagnostic-ceiling-only');
    expect(smoke).toContain('diagnostic-ceiling-occluder');
    expect(smoke).toContain('diagnostic-no-shadow');
    expect(smoke).toContain('perFramePassNames');
  });
});
