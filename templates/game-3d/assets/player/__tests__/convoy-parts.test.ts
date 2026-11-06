import { model, sel, type Model } from '@forgeax/engine/modeling';
import { expect, it } from 'vitest';
import { addConvoyPart, appendConvoyParts, type ConvoyBinding } from '../convoy-parts.ts';

it('keeps paired identity and placement when frame parts are queued before assembly', () => {
  const direct = [model(), model()] as const;
  const queued: [Model[], Model[]] = [[], []];
  const bindings: ConvoyBinding[] = [];
  const build = (part: Model, high: boolean) => { part.box({ size: [high ? 2 : 1, 1, 1] }); };
  const placement = { translate: [2, 3, 4] as [number, number, number], structural: true };
  addConvoyPart(direct, bindings, 'Chest', 'bake:test', build, placement);
  addConvoyPart(queued, bindings, 'Chest', 'bake:test', build, placement);
  expect(bindings).toEqual([{ tag: 'bake:test', joint: 'Chest' }, { tag: 'bake:test', joint: 'Chest' }]);
  for (const index of [0, 1] as const) {
    const merged = model();
    appendConvoyParts(merged, queued[index]);
    for (const target of [direct[index], merged]) {
      expect(target.count(sel.tag('bake:test').and(sel.tag('structural')))).toBe(6);
      expect(target.bounds(sel.all()).unwrap()).toEqual({ min: [index === 1 ? 1 : 1.5, 2.5, 3.5], max: [index === 1 ? 3 : 2.5, 3.5, 4.5] });
      expect(target.validate().closed).toBe(true);
    }
  }
});
