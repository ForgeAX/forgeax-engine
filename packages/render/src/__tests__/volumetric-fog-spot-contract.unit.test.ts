import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const componentSource = readFileSync(new URL('../volume/component.ts', import.meta.url), 'utf8');
const capabilitySource = readFileSync(new URL('../volume/capability.ts', import.meta.url), 'utf8');

describe('VolumetricFog selected-light contract', () => {
  it('requires a same-World Entity light and keeps only real light candidates', () => {
    expect(componentSource).toMatch(/readonly light:\s*EntityHandle/);
    expect(componentSource).toContain('type EntityHandle');
    expect(componentSource).toContain('DirectionalLight');
    expect(componentSource).toContain('SpotLight');
  });

  it('does not retain the synthetic directional resolver or snapshot exports', () => {
    expect(capabilitySource).not.toContain('VolumetricFogDirectionalLight');
    expect(capabilitySource).not.toContain('VolumetricFogCsmSnapshot');
    expect(capabilitySource).toContain('resolveSelectedVolumetricLight');
    expect(capabilitySource).toContain('resolveVolumetricFogLightPair');
    expect(capabilitySource).not.toContain('resolveVolumetricFogLight(');
  });

  it('documents closed reasons for unresolved light identity', () => {
    expect(componentSource).toMatch(/same-World|wrong-World|wrong component|light/i);
    expect(componentSource).toMatch(/same-World|wrong-World|wrong component|light/i);
  });
});
