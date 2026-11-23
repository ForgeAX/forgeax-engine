import { expect, it } from 'vitest';
import { FeatureSceneDataViews } from '../scene-data-views';

it('holds one catalog per admitted view and gives reappearing views fresh ownership', () => {
  const views = new FeatureSceneDataViews();
  const feature = { identity: 'example' };
  const a = views.admit('main', undefined, 1, true);
  const b = views.admit('mirror', undefined, 1, true);
  const catalog = a.catalog(feature, 3);
  views.retainViews(new Map([['mirror', true]]));
  const replaced = views.admit('main', undefined, 1, true);
  expect(replaced.revision).toBeGreaterThan(b.revision);
  expect(replaced.catalog(feature, 3)).not.toBe(catalog);
  expect(a.catalog(feature, 3)).toBe(catalog);
  expect(views.admit('mirror', undefined, 1, true)).toBe(b);
  expect(views.admit('mirror', undefined, 2, true).revision).toBeGreaterThan(replaced.revision);
});
