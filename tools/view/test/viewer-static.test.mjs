import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveViewerFile, viewerContentType } from '../packages/view-workspace-core/src/viewer-static.ts';
import { installedEngineRoot } from '../src/engine-root.ts';
import { startViewerStaticServer } from '../src/viewer-static-server.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'view-viewer-static-'));
  const staticRoot = join(root, 'viewer');
  const engineRoot = join(root, 'engine');
  const pkg = join(engineRoot, 'node_modules/@forgeax/engine-wgpu-wasm/pkg');
  await mkdir(join(staticRoot, 'assets'), { recursive: true });
  await mkdir(pkg, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html>');
  await writeFile(join(staticRoot, 'assets/main.js'), 'export {};');
  await writeFile(join(pkg, 'wgpu_wasm_bg.wasm'), 'engine bytes');
  return { root, staticRoot, engineRoot, wasm: join(pkg, 'wgpu_wasm_bg.wasm') };
}

test('viewer files resolve from the build and Engine binaries from the Engine root', async () => {
  const { root, staticRoot, engineRoot, wasm } = await fixture();
  try {
    assert.equal(resolveViewerFile(staticRoot, '/assets/main.js'), join(staticRoot, 'assets/main.js'));
    const asset = '/assets/engine/wgpu-wasm/Btuh15nT/wgpu_wasm_bg.wasm';
    assert.equal(resolveViewerFile(staticRoot, asset, engineRoot), wasm);
    assert.equal(viewerContentType(wasm), 'application/wasm');
    // Without an Engine root, or for absent/escaping names, nothing is served.
    assert.equal(resolveViewerFile(staticRoot, asset), undefined);
    assert.equal(resolveViewerFile(staticRoot, '/assets/engine/codec/x/basis.wasm', engineRoot), undefined);
    assert.equal(resolveViewerFile(staticRoot, '/assets/engine/wgpu-wasm/x/../../package.json', engineRoot), undefined);
    assert.equal(resolveViewerFile(staticRoot, '/../engine/node_modules', engineRoot), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the static viewer server serves the installed Engine binary for the built URL', async () => {
  const engineRoot = installedEngineRoot();
  assert.ok(engineRoot, 'View resolves its exact-version Engine');
  const { root, staticRoot } = await fixture();
  const server = await startViewerStaticServer({ staticRoot });
  try {
    const response = await fetch(`${server.viewerUrl}assets/engine/wgpu-wasm/hash/wgpu_wasm_bg.wasm`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/wasm');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
