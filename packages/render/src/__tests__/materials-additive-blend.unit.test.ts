import { RenderQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ADDITIVE_BLEND, Materials } from '../materials';

describe('Materials.unlit blendMode additive', () => {
  it('uses One + One colour, keeps destination alpha, skips depth writes and sorts as transparent', () => {
    expect(ADDITIVE_BLEND).toEqual({
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    });
    const material = Materials.unlit([1, 0.5, 0.2, 0.8], { blendMode: 'additive' });
    const forward = material.passes?.find((pass) => pass.name === 'forward');
    expect(forward?.renderState?.blend).toEqual(ADDITIVE_BLEND);
    expect(forward?.renderState?.depthWriteEnabled).toBe(false);
    expect(forward?.renderState?.queue).toBe(RenderQueue.Transparent);
    expect(material.values?.alphaMode).toBe(2);
    const shadow = material.passes?.find((pass) => pass.name === 'shadow-caster');
    expect(shadow?.renderState?.blend).toBeUndefined();
  });

  it('lets explicit renderState, queue and alphaMode override the preset', () => {
    const material = Materials.unlit([1, 1, 1, 1], {
      blendMode: 'additive',
      alphaMode: 'preserve',
      queue: RenderQueue.Overlay,
      renderState: { depthWriteEnabled: true, fog: false },
    });
    const forward = material.passes?.find((pass) => pass.name === 'forward');
    expect(forward?.renderState?.blend).toEqual(ADDITIVE_BLEND);
    expect(forward?.renderState?.depthWriteEnabled).toBe(true);
    expect(forward?.renderState?.fog).toBe(false);
    expect(forward?.renderState?.queue).toBe(RenderQueue.Overlay);
    expect(material.values?.alphaMode).toBe(0);
  });

  it('leaves materials without blendMode unchanged', () => {
    const forward = Materials.unlit([1, 1, 1, 1]).passes?.find((pass) => pass.name === 'forward');
    expect(forward?.renderState?.blend).toBeUndefined();
    expect(forward?.renderState?.queue).toBeUndefined();
  });
});
