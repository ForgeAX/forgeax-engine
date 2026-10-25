import { World } from '@forgeax/engine-ecs';
import type { PointShape } from '@forgeax/engine-render';
import {
  LineCapValue,
  Lines,
  LineWidthUnitsValue,
  lineCapFromU32,
  lineWidthUnitsFromU32,
  PointShapeValue,
  PointSizeUnitsValue,
  Points,
  pointShapeFromU32,
  pointSizeUnitsFromU32,
} from '@forgeax/engine-render';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('Points and Lines public schema', () => {
  it('creates both components through the public import and inserts them in World', () => {
    const world = new World();
    const pointEntity = world
      .spawn({
        component: Points,
        data: { size: 8, shape: PointShapeValue.circle },
      })
      .unwrap();
    const lineEntity = world.spawn({ component: Lines, data: { width: 4 } }).unwrap();

    expect(world.get(pointEntity, Points).unwrap()).toMatchObject({
      size: 8,
      shape: PointShapeValue.circle,
    });
    expect(world.get(lineEntity, Lines).unwrap()).toMatchObject({ width: 4 });
  });

  it('keeps the frozen defaults and closed point shape decoder', () => {
    const world = new World();
    const pointEntity = world.spawn({ component: Points, data: {} }).unwrap();
    const lineEntity = world.spawn({ component: Lines, data: {} }).unwrap();

    expect(world.get(pointEntity, Points).unwrap()).toMatchObject({
      size: 4,
      shape: PointShapeValue.square,
    });
    expect(world.get(lineEntity, Lines).unwrap().width).toBe(1);
    expect(Points.fields).toEqual({
      size: expect.objectContaining({ type: 'f32', default: 4 }),
      sizeUnits: expect.objectContaining({
        type: 'enum',
        default: PointSizeUnitsValue.pixels,
        labels: PointSizeUnitsValue,
      }),
      shape: expect.objectContaining({
        type: 'enum',
        default: PointShapeValue.square,
        labels: PointShapeValue,
      }),
    });
    expect(Lines.fields).toEqual({
      width: expect.objectContaining({ type: 'f32', default: 1 }),
      widthUnits: expect.objectContaining({
        type: 'enum',
        default: LineWidthUnitsValue.pixels,
        labels: LineWidthUnitsValue,
      }),
      cap: expect.objectContaining({
        type: 'enum',
        default: LineCapValue.butt,
        labels: LineCapValue,
      }),
      dashSize: expect.objectContaining({ type: 'f32', default: 1 }),
      gapSize: expect.objectContaining({ type: 'f32', default: 0 }),
      dashOffset: expect.objectContaining({ type: 'f32', default: 0 }),
    });
    expect(pointShapeFromU32(PointShapeValue.square)).toBe('square');
    expect(pointShapeFromU32(PointShapeValue.circle)).toBe('circle');
    expect(pointShapeFromU32(PointShapeValue.soft)).toBe('soft');
    expect(pointShapeFromU32(99)).toBeUndefined();
    expect(pointSizeUnitsFromU32(PointSizeUnitsValue.pixels)).toBe('pixels');
    expect(pointSizeUnitsFromU32(PointSizeUnitsValue.world)).toBe('world');
    expect(pointSizeUnitsFromU32(2)).toBeUndefined();
    expect(lineWidthUnitsFromU32(LineWidthUnitsValue.pixels)).toBe('pixels');
    expect(lineWidthUnitsFromU32(LineWidthUnitsValue.world)).toBe('world');
    expect(lineWidthUnitsFromU32(2)).toBeUndefined();
    expect(lineCapFromU32(LineCapValue.butt)).toBe('butt');
    expect(lineCapFromU32(LineCapValue.round)).toBe('round');
    expect(lineCapFromU32(2)).toBeUndefined();
  });

  it('exposes the bounded point and line style vocabulary', () => {
    type PublicPointShape = PointShape;
    expectTypeOf<PublicPointShape>().toEqualTypeOf<'square' | 'circle' | 'soft'>();
    expectTypeOf<keyof typeof Points.fields>().toEqualTypeOf<'size' | 'sizeUnits' | 'shape'>();
    expectTypeOf<keyof typeof Lines.fields>().toEqualTypeOf<
      'width' | 'widthUnits' | 'cap' | 'dashSize' | 'gapSize' | 'dashOffset'
    >();
  });
});
