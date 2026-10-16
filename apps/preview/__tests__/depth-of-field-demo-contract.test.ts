import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Manifest = {
  readonly id?: string;
  readonly roots: { engine?: string };
};

describe('static depth-of-field Preview demo contract', () => {
  it('uses a dedicated plugin manifest without the animated game scene', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../apps/game-capability-lab/depth-of-field.forge.json', import.meta.url), 'utf8'),
    ) as Manifest;
    expect(manifest.id).toBe('depth-of-field');
    expect(manifest.roots.engine).toEqual(expect.any(String));
  });

  it('keeps the authored scene deterministic and free of gameplay animation hooks', () => {
    const source = readFileSync(
      new URL('../../../apps/game-capability-lab/assets/depth-of-field.plugin.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("animated: false");
    expect(source).toContain("id: 'depth-of-field.set-preset'");
    expect(source).toContain("focusDistance: 9");
    expect(source).toContain("blurSide: 'near'");
    expect(source).toContain("blurSide: 'far'");
  });
});
