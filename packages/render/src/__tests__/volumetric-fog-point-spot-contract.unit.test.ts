import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const componentSource = readFileSync(new URL('../volume/component.ts', import.meta.url), 'utf8');
const capabilitySource = readFileSync(new URL('../volume/capability.ts', import.meta.url), 'utf8');

describe('VolumetricFog exact Point+Spot authoring contract', () => {
  it('exposes a closed pair instead of a single selected light', () => {
    expect(componentSource).toMatch(/readonly light:\s*EntityHandle/);
    expect(componentSource).toMatch(/readonly spotLight\??:\s*EntityHandle/);
    expect(capabilitySource).toContain("'point-spot'");
    expect(capabilitySource).toContain('PointLight');
  });

  it('keeps pair selection same-World and rejects arbitrary light counts', () => {
    expect(capabilitySource).toContain('same World');
    expect(capabilitySource).toMatch(/exactly (one|two)|ambiguous/);
    expect(capabilitySource).not.toContain('forEachLight');
    expect(capabilitySource).not.toContain('lights: EntityHandle[]');
  });

  it('retains structured failure fields for invalid pair authoring', () => {
    expect(componentSource).toMatch(/code/);
    expect(componentSource).toMatch(/expected/);
    expect(componentSource).toMatch(/hint/);
    expect(componentSource).toMatch(/detail/);
  });
});
