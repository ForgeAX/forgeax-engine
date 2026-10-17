import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reportWorkspaceCommandError, subscribeWorkspaceCommandErrors } from '../packages/view-workspace-core/src/command-error.ts';
import { workspaceError } from '../packages/view-workspace-core/src/contract.ts';
import {
  createViewPageHost,
  createViewPageTypeRegistry,
  planResourcePageActivation,
  resolveResourcePageType,
} from '../packages/viewer/src/host/page-registry.ts';

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

describe('programmatic resource open', () => {
  it('opens or focuses the resolved singleton PageType and replaces the subject by later requests', () => {
    const registry = createViewPageTypeRegistry();
    const host = createViewPageHost({ registry });
    host.registerType(pageType({
      context: 'project',
      typeId: 'material',
      resourceSelector: { kinds: ['material'] },
      priority: 20,
    }));
    const opened = [];
    const unsubscribe = host.subscribeResourceOpen((request) => {
      const resolved = resolveResourcePageType(registry.getTypes(), request.asset);
      assert.equal(resolved.ok, true);
      opened.push({ typeId: resolved.pageType.typeId, guid: request.asset.guid, requestId: request.requestId });
    });
    host.openResource({
      requestId: 'open-a',
      sequence: 1,
      asset: { guid: 'mat-a', kind: 'material' },
    });
    host.openResource({
      requestId: 'open-b',
      sequence: 2,
      asset: { guid: 'mat-b', kind: 'material' },
    });
    assert.deepEqual(opened, [
      { typeId: 'material', guid: 'mat-a', requestId: 'open-a' },
      { typeId: 'material', guid: 'mat-b', requestId: 'open-b' },
    ]);
    unsubscribe();
  });

  it('reports a structured error when no plugin matches and does not invent a page', () => {
    const registry = createViewPageTypeRegistry();
    const host = createViewPageHost({ registry });
    const errors = [];
    const stop = subscribeWorkspaceCommandErrors((error) => errors.push(error));
    host.subscribeResourceOpen((request) => {
      const resolved = resolveResourcePageType(registry.getTypes(), request.asset);
      if (!resolved.ok) {
        reportWorkspaceCommandError(
          workspaceError(
            resolved.error.code,
            resolved.error.expected,
            resolved.error.hint,
            resolved.error.detail,
          ),
          { operation: 'asset.open' },
        );
      }
    });
    host.openResource({
      requestId: 'open-unknown',
      sequence: 1,
      asset: { guid: 'curve-1', kind: 'curve' },
    });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'view-resource-page-unavailable');
    assert.equal(errors[0].detail.kind, 'curve');
    stop();
  });

  it('resolves scenes to Scene and focuses the existing non-openable singleton', () => {
    const registry = createViewPageTypeRegistry();
    const host = createViewPageHost({ registry });
    host.registerType(pageType({
      context: 'project',
      typeId: 'scene',
      openable: false,
      initial: true,
      resourceSelector: { kinds: ['scene'] },
      priority: 10,
    }));
    host.registerType(pageType({
      context: 'project',
      typeId: 'asset',
      resourceSelector: { fallback: true },
      priority: 0,
    }));
    const resolved = resolveResourcePageType(registry.getTypes(), { kind: 'scene' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.pageType.typeId, 'scene');
    const pages = [{ id: 'page-scene', typeId: 'scene', title: 'Scene', closable: false }];
    assert.deepEqual(planResourcePageActivation(pages, resolved.pageType), {
      action: 'focus',
      pageId: 'page-scene',
      pageType: resolved.pageType,
    });
  });

  it('opens a new material singleton page', () => {
    const registry = createViewPageTypeRegistry();
    const host = createViewPageHost({ registry });
    host.registerType(pageType({
      context: 'project',
      typeId: 'material',
      resourceSelector: { kinds: ['material'] },
      priority: 20,
    }));
    const resolved = resolveResourcePageType(registry.getTypes(), { kind: 'material' });
    assert.equal(resolved.pageType.typeId, 'material');
    assert.deepEqual(planResourcePageActivation([], resolved.pageType), {
      action: 'open',
      pageId: 'page-material',
      pageType: resolved.pageType,
    });
  });
});
