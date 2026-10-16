import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Built-in programs that can be drawn with a blend state. Each one fogs itself
// at its own depth through the View copy selected by its blend composition.
const TRANSLUCENT_WRITERS = [
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
  'unlit.wgsl',
  'sprite.wgsl',
  'sprite-lit.wgsl',
  'msdf-text.wgsl',
  'points-lines.wgsl',
] as const;
// The opaque fog pass owns these: the sky stays unfogged background and
// deferred lighting is fogged in place after it resolves.
const OPAQUE_ONLY = ['skybox.wgsl', 'standard-deferred-lighting.wgsl'] as const;

const shaderSource = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

describe('Built-in fog producer matrix', () => {
  it('fogs every blended built-in writer at its own depth', () => {
    for (const file of TRANSLUCENT_WRITERS) {
      const source = shaderSource(file);
      expect(source, file).toMatch(
        /#import forgeax_view::fog::\{translucent_fog(?:_transmission)?\}/,
      );
      expect(
        source.match(/translucent_fog(?:_transmission)?\(view,/g)?.length ?? 0,
        file,
      ).toBeGreaterThan(0);
    }
  });

  it('leaves opaque-only programs to the opaque fog pass', () => {
    for (const file of OPAQUE_ONLY) {
      expect(shaderSource(file), file).not.toContain('forgeax_view::fog');
    }
    expect(shaderSource('analytic-fog.wgsl')).toContain('height_fog(fog_view,');
    expect(shaderSource('analytic-fog.wgsl')).toContain('if depth <= 0.0 { discard; }');
  });

  it('keeps one fog evaluation without private per-shader fog entry points', () => {
    const sources = [...TRANSLUCENT_WRITERS, ...OPAQUE_ONLY].map(shaderSource).join('\n');
    expect(sources.match(/apply_fog|applySceneFog|FogRay|fn view_fog/g)).toBeNull();
    const composite = shaderSource('volume/volume-composite.wgsl');
    expect(shaderSource('volume/volume-integrate.wgsl')).toContain('fn hg');
    expect(shaderSource('volume/volume-integrate.wgsl')).toContain('local_scatter');
    expect(composite).toContain('composite_resolved_volume');
  });
});
