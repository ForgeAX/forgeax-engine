import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as enginePlugin from '@forgeax/engine-plugin';
import viewPlugin from '../src/plugin.ts';

test('View uses Engine 0.2 native plugin assets and Cordis ownership', () => {
  assert.equal(typeof enginePlugin.mountPluginAsset, 'function');
  assert.equal(typeof enginePlugin.inspectPluginFiber, 'function');
  assert.equal(typeof enginePlugin.registerTools, 'function');
  assert.equal(typeof viewPlugin.apply, 'function');
  assert.equal(viewPlugin.name, 'forgeax.view');
});
