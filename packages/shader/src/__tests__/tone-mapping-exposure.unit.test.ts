import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TONEMAP_SHADER_MODE } from '../tonemap';

const toneMapping = readFileSync(resolve(import.meta.dirname, '..', 'tone-mapping.wgsl'), 'utf8');

// Three's toneMappingExposure scales the input of every operator and is
// ignored only by NoToneMapping. Camera.exposure mirrors that contract.
describe('mapTone exposure contract', () => {
  const body = toneMapping.slice(toneMapping.indexOf('fn mapTone('));
  const operators = Object.entries(TONEMAP_SHADER_MODE).filter(([name]) => name !== 'none');

  it.each(operators)('feeds the exposed sample to %s', (_name, mode) => {
    const line = body.split('\n').find((candidate) => candidate.includes(`case ${mode}u:`));
    expect(line, `mapTone case ${mode}u`).toBeDefined();
    expect(line).toContain('(exposed');
  });

  it('applies exposure once before the switch and leaves only none unexposed', () => {
    expect(body).toContain('let exposed : vec3<f32> = sample * exposure;');
    expect(TONEMAP_SHADER_MODE.none).toBe(0);
    expect(body).toMatch(/default: \{ mapped = toneMapLinearLdr\(sample,/);
  });
});
