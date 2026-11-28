import { describe, expect, it } from 'vitest';
import {
  axisRotation,
  booleanSolids,
  draftedPrism,
  filletBox,
  filletCylinder,
  filletPrism,
  housing,
  IDENTITY_PLACEMENT,
  pipeElbow,
  quadrangulate,
  revolveShell,
  tessellate,
  transformShape,
  tub,
} from '../index';

describe('brep barrel', () => {
  it('exposes the public boolean entry', () => {
    expect(typeof booleanSolids).toBe('function');
  });

  it('exposes the implemented feature operations and placement helpers', () => {
    for (const fn of [
      filletBox,
      filletCylinder,
      filletPrism,
      draftedPrism,
      pipeElbow,
      tub,
      revolveShell,
      housing,
      transformShape,
      axisRotation,
    ]) {
      expect(typeof fn).toBe('function');
    }
    expect(IDENTITY_PLACEMENT).toBeDefined();
  });

  it('still exposes the closed-form quadrangulate and tessellate surface', () => {
    expect(typeof quadrangulate).toBe('function');
    expect(typeof tessellate).toBe('function');
  });
});
