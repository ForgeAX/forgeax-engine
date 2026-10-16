import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createViewPageHost,
  createViewPageTypeRegistry,
  resolveResourcePageType,
} from '../packages/viewer/src/host/page-registry.ts';

import { createResourcePageTypeContribution } from '../packages/view-workspace-core/src/resource-page.ts';
import * as materialIdentity from '../packages/view-plugin-material/src/identity.ts';

function pageType(input) {
  return {
    title: input.typeId,
    order: input.order ?? 10,
    closable: true,
    singleton: true,
    initial: false,
    openable: true,
    layout: 'dock',
    showPanelRail: true,
    hideWhenInactive: true,
    ...input,
  };
}

describe('PageType resource selector', () => {
  it('registers the production resource page as project context', () => {
    const registry = createViewPageTypeRegistry();
    const unregister = registry.registerType(createResourcePageTypeContribution(materialIdentity));
    assert.equal(registry.getTypes()[0].context, 'project');
    unregister();
    assert.equal(registry.getTypes().length, 0);
  });
  it('resolves kind matches by priority then order, and uses fallback last', () => {
    const registry = createViewPageTypeRegistry();
    const host = createViewPageHost({ registry });
    const disposeFallback = host.registerType(pageType({
      context: 'project',
      typeId: 'asset',
      order: 80,
      priority: 0,
      resourceSelector: { fallback: true },
    }));
    const disposeLow = host.registerType(pageType({
      context: 'project',
      typeId: 'material-low',
      order: 1,
      priority: 1,
      resourceSelector: { kinds: ['material'] },
    }));
    const disposeHigh = host.registerType(pageType({
      context: 'project',
      typeId: 'material',
      order: 30,
      priority: 20,
      resourceSelector: { kinds: ['material'] },
    }));
    const material = resolveResourcePageType(registry.getTypes(), { kind: 'material' });
    assert.equal(material.ok, true);
    assert.equal(material.pageType.typeId, 'material');
    assert.equal(material.match, 'kind');
    const unknown = resolveResourcePageType(registry.getTypes(), { kind: 'curve' });
    assert.equal(unknown.ok, true);
    assert.equal(unknown.pageType.typeId, 'asset');
    assert.equal(unknown.match, 'fallback');
    disposeHigh();
    const afterUninstall = resolveResourcePageType(registry.getTypes(), { kind: 'material' });
    assert.equal(afterUninstall.ok, true);
    assert.equal(afterUninstall.pageType.typeId, 'material-low');
    disposeLow();
    const fallbackOnly = resolveResourcePageType(registry.getTypes(), { kind: 'material' });
    assert.equal(fallbackOnly.ok, true);
    assert.equal(fallbackOnly.pageType.typeId, 'asset');
    disposeFallback();
    const missing = resolveResourcePageType(registry.getTypes(), { kind: 'material' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'view-resource-page-unavailable');
    assert.equal(missing.error.detail.kind, 'material');
  });

  it('revokes matching as soon as the contributing Fiber unregisters the PageType', () => {
    const registry = createViewPageTypeRegistry();
    const host = createViewPageHost({ registry });
    const dispose = host.registerType(pageType({
      context: 'project',
      typeId: 'mesh',
      resourceSelector: { kinds: ['mesh'] },
    }));
    assert.equal(resolveResourcePageType(registry.getTypes(), { kind: 'mesh' }).pageType.typeId, 'mesh');
    dispose();
    const resolved = resolveResourcePageType(registry.getTypes(), { kind: 'mesh' });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.error.code, 'view-resource-page-unavailable');
  });

  it('routes mesh and texture to dedicated pages and unknown kinds to fallback', () => {
    const registry = createViewPageTypeRegistry();
    const host = createViewPageHost({ registry });
    host.registerType(pageType({
      context: 'project',
      typeId: 'editor',
      openable: false,
      resourceSelector: { kinds: ['scene'] },
      priority: 10,
    }));
    host.registerType(pageType({
      context: 'project',
      typeId: 'mesh',
      resourceSelector: { kinds: ['mesh'] },
      priority: 20,
    }));
    host.registerType(pageType({
      context: 'project',
      typeId: 'texture',
      resourceSelector: { kinds: ['texture', 'image'] },
      priority: 20,
    }));
    host.registerType(pageType({
      context: 'project',
      typeId: 'asset',
      resourceSelector: { fallback: true },
      priority: 0,
      order: 80,
    }));
    assert.equal(resolveResourcePageType(registry.getTypes(), { kind: 'mesh' }).pageType.typeId, 'mesh');
    assert.equal(resolveResourcePageType(registry.getTypes(), { kind: 'image' }).pageType.typeId, 'texture');
    assert.equal(resolveResourcePageType(registry.getTypes(), { kind: 'scene' }).pageType.typeId, 'editor');
    assert.equal(resolveResourcePageType(registry.getTypes(), { kind: 'curve' }).pageType.typeId, 'asset');
  });
});
