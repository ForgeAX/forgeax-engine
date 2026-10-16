import { describe, expect, it } from 'vitest';
import { SkinMaterialMismatchError } from '../../../render/src/errors/render';

describe('render skin errors stay outside skinning binding', () => {
  it('retains material failures in runtime render error cluster', () => {
    const error = new SkinMaterialMismatchError(3, 'forgeax::pbr');
    expect(error.code).toBe('skin-material-mismatch');
    expect(error.detail.entity).toBe(3);
  });
});
