import buildRevision from '../packages/viewer/src/build-identity.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostAssembly } from '@forgeax/engine-host/protocol';
import { Context } from '@forgeax/engine/plugin';
import { resolveViewFrontendRoot } from '../packages/viewer/src/host/frontend.ts';
import { createViewFrontendRoot } from '../packages/viewer/src/frontend-root.ts';
import { VIEW_PRODUCT_FRONTEND_CATALOG } from '../packages/viewer/src/frontend-catalog.ts';
import { VIEW_FRONTEND_ROOT_PROGRAM, VIEW_PLUGIN_VERSION, viewFrontendRoot } from '../packages/viewer/src/catalog-shared.ts';
import viewportFrontendPlugin from '../packages/view-plugin-viewport/src/frontend.ts';
import * as viewportIdentity from '../packages/view-plugin-viewport/src/identity.ts';
import * as materialIdentity from '../packages/view-plugin-material/src/identity.ts';
import * as meshIdentity from '../packages/view-plugin-mesh/src/identity.ts';
import * as textureIdentity from '../packages/view-plugin-texture/src/identity.ts';
import * as assetIdentity from '../packages/view-plugin-asset/src/identity.ts';

test('viewport dock is not deferred behind Engine workspace presentation', () => {
  assert.equal(
    VIEW_PRODUCT_FRONTEND_CATALOG.get(viewportIdentity.FRONTEND_MODULE).requiresWorkspacePresentation,
    false,
    'The fill dock must start with the other editor panels',
  );
  assert.deepEqual(viewportFrontendPlugin.inject, ['viewOperationClient', 'viewScenePage']);
  assert.equal(viewportFrontendPlugin.inject.includes('viewPlayPresentation'), false);
  assert.equal(viewportFrontendPlugin.inject.includes('engineWorkspacePresentation'), false);
  for (const identity of [materialIdentity, meshIdentity, textureIdentity, assetIdentity]) {
    assert.equal(
      VIEW_PRODUCT_FRONTEND_CATALOG.get(identity.FRONTEND_MODULE).requiresWorkspacePresentation,
      true,
      identity.FRONTEND_MODULE,
    );
  }
});

test('HostAssembly v2 projects one exact View frontend root', async () => {
  const assembly = createHostAssembly({ root: viewFrontendRoot({ embedded: true }, ['display']) });
  assert.equal(assembly.schemaVersion, 2);
  assert.equal(assembly.root.program, VIEW_FRONTEND_ROOT_PROGRAM);
  assert.equal(assembly.root.codeRevision, buildRevision);
  assert.deepEqual(assembly.root.config.disabledPages, ['display']);
  assert.equal(typeof (await resolveViewFrontendRoot(assembly.root)).apply, 'function');
  await assert.rejects(resolveViewFrontendRoot({ program: 'another-product' }), /Unexpected View frontend root/);
});

test('frontend root activates before Engine supplies the headed presentation', async () => {
  const original = new Map(VIEW_PRODUCT_FRONTEND_CATALOG);
  const context = new Context();
  let presentationActive = 0;
  try {
    let first = true;
    for (const [module] of original) {
      const shell = first;
      first = false;
      VIEW_PRODUCT_FRONTEND_CATALOG.set(module, { requiresWorkspacePresentation: !shell, load: async () => ({ default: {
        name: `test.${module}`,
        ...(shell ? {} : { inject: ['engineWorkspacePresentation'] }),
        apply(ctx) {
          if (!shell) {
            presentationActive++;
            ctx.effect(() => () => { presentationActive--; });
          }
        },
      } }) });
    }
    const root = context.plugin(createViewFrontendRoot(), { frontendConfig: { embedded: true } });
    await Promise.race([
      root.await(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('frontend root waited for Engine presentation')), 1000)),
    ]);
    assert.equal(presentationActive, 0);
    context.provide('engineWorkspacePresentation', {});
    await context.fiber.await();
    assert.ok(presentationActive > 0);
    const mounted = presentationActive;
    await root.dispose();
    assert.equal(presentationActive, 0, 'removing the View root revokes its presentation children');
    const restored = context.plugin(createViewFrontendRoot(), { frontendConfig: { embedded: true } });
    await restored.await();
    await context.fiber.await();
    assert.equal(presentationActive, mounted, 'a fresh root restores its presentation children');
  } finally {
    VIEW_PRODUCT_FRONTEND_CATALOG.clear();
    for (const [key, value] of original) VIEW_PRODUCT_FRONTEND_CATALOG.set(key, value);
    await context.fiber.dispose();
  }
});
