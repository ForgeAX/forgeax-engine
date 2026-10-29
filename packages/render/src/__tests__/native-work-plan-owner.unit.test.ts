import { describe, expect, it, vi } from 'vitest';
import type { RenderFeatureResourceDeclaration, RenderFeatureWork } from '../features/plan';
import {
  consumeRenderFeatureNativePlan,
  createRenderFeatureNativePlanBuilder,
  isRenderFeatureNativePlan,
} from '../features/prepared-gpu-work';

function owner() {
  return {
    transaction: {},
    featureIdentity: 'stock.vfx',
    frameNumber: 21,
    generation: 3,
    views: [
      { identity: 'main', render: true },
      { identity: 'held', render: false },
    ],
  };
}
describe('Host-bound native work plan owner', () => {
  it('publishes and consumes the exact primary IR including arena replacement arrays', () => {
    const expected = owner();
    const createAdmission = vi.fn(() => {
      throw new Error('Unused admission must stay unprepared');
    });
    const builder = createRenderFeatureNativePlanBuilder(expected, createAdmission);
    const frame = builder.scope('frame');
    const view = builder.scope({ view: 'main' });
    expect(builder.scope('frame')).toBe(frame);
    expect(builder.scope({ view: 'main' })).toBe(view);
    const data = new Uint32Array([1, 2]);
    const bodyRead = vi.fn(() => {
      throw new Error('Must not inspect declarations');
    });
    const resource = Object.defineProperty(
      { kind: 'buffer', name: 'state', size: 8, usage: ['storage'], data },
      'future',
      { enumerable: true, get: bodyRead },
    ) as RenderFeatureResourceDeclaration;
    frame.resources.push(resource);
    const replacement = { ...frame, resources: [...frame.resources] };
    const work = [replacement, view];
    const feedback = { accepted: [1] };
    const planned = builder.finish(work, feedback);
    expect(createAdmission).not.toHaveBeenCalled();
    expect(planned.work).toEqual([]);
    expect(planned.sourceFeedback).toBe(feedback);
    expect(planned.native).toBeDefined();
    expect(Object.keys(planned.native ?? {})).toEqual([]);
    expect(bodyRead).not.toHaveBeenCalled();
    expect(Object.isFrozen(work)).toBe(false);
    expect(Object.isFrozen(resource)).toBe(false);
    expect(Object.isFrozen(data)).toBe(false);
    expect(isRenderFeatureNativePlan(planned)).toBe(true);
    expect(isRenderFeatureNativePlan(planned.native)).toBe(false);
    const consumed = consumeRenderFeatureNativePlan(planned, expected);
    expect(consumed).toBe(work);
    expect(consumed?.[0]).toBe(replacement);
    expect(consumed?.[0]?.resources).toBe(replacement.resources);
    expect(consumed?.[1]).toBe(view);
    expect(bodyRead).not.toHaveBeenCalled();
    expect(isRenderFeatureNativePlan(planned)).toBe(true);
    expect(consumeRenderFeatureNativePlan(planned, expected)).toBeUndefined();
    expect(() => builder.scope('frame')).toThrow('closed');
    expect(() => builder.finish(work)).toThrow('closed');
  });
  it('checks exact Host facts and roster before allowing a single consumption', () => {
    const expected = owner();
    const builder = createRenderFeatureNativePlanBuilder(expected);
    const work = [builder.scope('frame')];
    const planned = builder.finish(work);
    const wrongOwners = [
      { ...expected, transaction: {} },
      { ...expected, featureIdentity: 'other' },
      { ...expected, frameNumber: 22 },
      { ...expected, generation: 4 },
      { ...expected, views: expected.views.slice(0, 1) },
      { ...expected, views: [...expected.views].reverse() },
      { ...expected, views: expected.views.map((view) => ({ ...view, render: true })) },
    ];
    for (const wrong of wrongOwners)
      expect(consumeRenderFeatureNativePlan(planned, wrong)).toBeUndefined();
    for (const forged of [undefined, null, 1, {}, planned.native, { ...planned }]) {
      expect(isRenderFeatureNativePlan(forged)).toBe(false);
      expect(consumeRenderFeatureNativePlan(forged, expected)).toBeUndefined();
    }
    const nativeRead = vi.fn(() => {
      throw new Error('Raw native getter must stay unread');
    });
    const raw = Object.defineProperty({ work: [] }, 'native', { get: nativeRead });
    expect(isRenderFeatureNativePlan(raw)).toBe(false);
    expect(consumeRenderFeatureNativePlan(raw, expected)).toBeUndefined();
    expect(nativeRead).not.toHaveBeenCalled();
    expect(consumeRenderFeatureNativePlan(planned, expected)).toBe(work);
    expect(isRenderFeatureNativePlan(planned)).toBe(true);
    expect(consumeRenderFeatureNativePlan(planned, expected)).toBeUndefined();
  });
  it('binds the roster scalars when Host creates the builder', () => {
    const original = owner();
    const expected = { ...owner(), transaction: original.transaction };
    const builder = createRenderFeatureNativePlanBuilder(original);
    const view = original.views[0];
    if (!view) throw new Error('Missing view');
    view.identity = 'replacement';
    view.render = false;
    original.frameNumber = 99;
    original.transaction = {};
    const work = [builder.scope({ view: 'main' })];
    expect(() => builder.scope({ view: 'replacement' })).toThrow('Unknown');
    const planned = builder.finish(work);
    expect(consumeRenderFeatureNativePlan(planned, original)).toBeUndefined();
    expect(consumeRenderFeatureNativePlan(planned, expected)).toBe(work);
  });
  it.each([
    'unknown',
    'uncreated',
    'duplicate',
  ] as const)('rejects %s final scopes without issuing a usable token or allowing another finish', (kind) => {
    const builder = createRenderFeatureNativePlanBuilder(owner());
    const frame = builder.scope('frame');
    const scope = kind === 'unknown' ? 'unknown' : 'main';
    const work: readonly RenderFeatureWork[] =
      kind === 'duplicate'
        ? [frame, { ...frame }]
        : [frame, { scope: { view: scope }, resources: [], passes: [] }];
    expect(() => builder.finish(work)).toThrow();
    expect(() => builder.finish([frame])).toThrow('closed');
    expect(() => builder.scope('frame')).toThrow('closed');
  });
  it('allows only frame and listed views and rejects duplicate Host view identities', () => {
    const expected = owner();
    const builder = createRenderFeatureNativePlanBuilder(expected);
    expect(() => builder.scope({ view: 'unknown' })).toThrow('Unknown');
    expect(builder.scope({ view: 'held' }).scope).toEqual({ view: 'held' });
    const work = [builder.scope('frame')];
    expect(consumeRenderFeatureNativePlan(builder.finish(work), expected)).toBe(work);
    expect(() =>
      createRenderFeatureNativePlanBuilder({
        ...expected,
        views: [
          { identity: 'main', render: true },
          { identity: 'main', render: false },
        ],
      }),
    ).toThrow('Duplicate');
  });
});
