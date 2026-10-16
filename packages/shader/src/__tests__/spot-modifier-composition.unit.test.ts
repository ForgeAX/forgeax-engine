import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('shared Spot modifier shader composition', () => {
  it('names one shared evaluator with the frozen multiplication order', async () => {
    const source = await readFile(
      new URL('../lighting-spot-modifiers.wgsl', import.meta.url),
      'utf8',
    );
    expect(source).toContain('spotModifierProduct');
    expect(source).toMatch(/brdf[\s\S]*range[\s\S]*cone[\s\S]*ies[\s\S]*cookie[\s\S]*shadow/);
  });

  it('keeps modifier sampling behind the extended-lighting topology', async () => {
    const punctual = await readFile(new URL('../lighting-punctual.wgsl', import.meta.url), 'utf8');
    expect(punctual).toContain('extendedLighting');
    expect(punctual).not.toContain('modifierLight');
  });
});
