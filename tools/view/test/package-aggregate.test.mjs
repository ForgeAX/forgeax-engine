import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
test('the built tool keeps all explicit native public exports and a usable host Pack', async () => {
 const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
 for (const target of Object.values(manifest.exports)) await readFile(new URL(`../${target}`, import.meta.url));
 const { default: product } = await import('../dist/modules/plugin.mjs');
 assert.equal(typeof product.apply, 'function');
 const { default: frontend } = await import('../dist/modules/frontend-root.mjs');
 assert.equal(typeof frontend.apply, 'function');
 const pack = JSON.parse(await readFile(new URL('../host.pack.json', import.meta.url)));
 assert.equal(pack.assets['plugin/main'].payload.module.specifier, './dist/modules/plugin.mjs');
});
