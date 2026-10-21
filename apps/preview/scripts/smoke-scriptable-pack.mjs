#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const PORT = Number.parseInt(process.env.FORGEAX_SCRIPTABLE_PACK_PORT ?? '5217', 10);
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_SCRIPTABLE_PACK_DIR ?? resolve(ROOT, '.forgeax-debug/resonance-forge'),
);
const EXPECTED_KINDS = [
  'material',
  'material',
  'material',
  'material',
  'mesh',
  'mesh',
  'mesh',
  'mesh',
  'mesh',
  'scene',
  'texture',
  'sampler',
  'animation-clip',
  'animation-graph',
  'audio',
  'particle-effect',
];
mkdirSync(ARTIFACT_DIR, { recursive: true });

const server = spawn(
  'pnpm',
  ['--filter', '@forgeax/preview', 'dev', '--host', '127.0.0.1', '--port', String(PORT)],
  {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development' },
  },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--ignore-gpu-blocklist',
  ],
  chromiumSandbox: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (
    message.type() === 'error' &&
    message.text() !== 'Failed to load resource: the server responded with a status of 404 (Not Found)'
  ) {
    consoleErrors.push(message.text());
  }
});
page.on('response', (response) => {
  const expectedMissingImport = response.url().endsWith(
    '/__pack/scopes/preview/1/import/019ffa97-9000-7000-8000-000000009999',
  );
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico') && !expectedMissingImport) {
    badResponses.push(`${response.status()} ${response.url()}`);
  }
});

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`);
      if (response.ok) break;
    } catch {}
    await sleep(100);
  }
  await page.goto(`http://127.0.0.1:${PORT}/?game=game-default`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-default.snapshot') ?? false,
    undefined,
    { timeout: 60_000 },
  );
  await page.waitForFunction(
    async () => (await globalThis.__forgeaxPreviewInspection.read('game-default.snapshot')).value?.resonanceForge?.status === 'ready',
    undefined,
    { timeout: 60_000 },
  );
  const before = await page.evaluate(
    async () => (await globalThis.__forgeaxPreviewInspection.read('game-default.snapshot')).value.resonanceForge,
  );
  await page.waitForTimeout(500);
  const proof = await page.evaluate(async () => {
    const snapshot = (await globalThis.__forgeaxPreviewInspection.read('game-default.snapshot')).value.resonanceForge;
    const health = globalThis.__forgeaxPreviewInspection.renderer.health();
    const indexPayload = await fetch('/__pack/scopes/preview/1/catalog.json').then((response) => response.json());
    const index = Array.isArray(indexPayload) ? indexPayload : indexPayload.entries ?? [];
    const importResponse = await fetch(
      '/__pack/scopes/preview/1/import/019e2cc6-0c86-79da-aa76-b0984c86d461',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'scriptable-pack-browser-smoke' }),
      },
    );
    const imported = JSON.parse(await importResponse.text());
    const rows = index.filter((entry) => entry.packageId === snapshot.packageId);
    const packageUrls = [...new Set(rows.map((entry) => entry.packageUrl))];
    const assets = globalThis.__forgeaxPreviewInspection.assets;
    const loaded = await Promise.all(rows.map(async (entry) => {
      const guid = assets.parseGuid(entry.guid);
      const loaded = await assets.load(guid, entry.kind);
      return { entry, result: loaded.ok ? assets.read(loaded.value) : loaded };
    }));
    const loadedKinds = loaded.map(({ result }) => result.ok ? result.value.kind : null);
    const loadedMembers = loaded.map(({ result }) => {
      if (!result.ok) return { ok: false, code: result.error.code, hint: result.error.hint, detail: result.error.detail };
      switch (result.value.kind) {
        case 'scene': return { ok: true, member: 'entities', count: Object.keys(result.value.entities).length };
        case 'mesh': return { ok: true, member: 'vertices', count: result.value.vertices.length };
        case 'material': return { ok: true, member: 'passes', count: result.value.passes?.length ?? 0 };
        case 'texture': return { ok: true, member: 'width', count: result.value.shape.extent.width };
        case 'equirect': return { ok: true, member: 'width', count: result.value.width };
        case 'sampler': return { ok: true, member: 'magFilter', count: result.value.magFilter === undefined ? 0 : 1 };
        case 'font': return { ok: true, member: 'glyphs', count: Object.keys(result.value.glyphs).length };
        case 'render-pipeline': return { ok: true, member: 'pipelineId', count: result.value.pipelineId.length };
        case 'tileset': return { ok: true, member: 'atlases', count: result.value.atlases.length };
        case 'video': return { ok: true, member: 'url', count: result.value.url.length };
        case 'skeleton': return { ok: true, member: 'jointCount', count: result.value.jointCount };
        case 'skin': return { ok: true, member: 'jointPaths', count: result.value.jointPaths.length };
        case 'animation-clip': return { ok: true, member: 'duration', count: result.value.duration };
        case 'animation-graph': return { ok: true, member: 'nodes', count: result.value.nodes.length };
        case 'audio': return { ok: true, member: 'sourceKey', count: result.value.sourceKey.length };
        case 'particle-effect': return { ok: true, member: 'program.emitters', count: result.value.program.emitters.length };
      }
    });
    const missing = await assets.load('019ffa97-9000-7000-8000-000000009999', 'mesh');
    const pack = packageUrls.length === 0
      ? { assets: [] }
      : await fetch(packageUrls[0]).then((response) => response.json());
    const scene = pack.assets.find((asset) => asset.kind === 'scene');
    return {
      snapshot,
      health,
      rows,
      packageUrls,
      packageAssetCount: pack.assets.length,
      assetRegistry: {
        loadedKinds,
        loadedMembers,
        allLoaded: loaded.every(({ result }) => result.ok),
        allKinds: [...loadedKinds].sort(),
        memberProofComplete: loadedMembers.every(({ ok, member }) => ok && member !== undefined),
        missingFailure: missing.ok ? null : {
          code: missing.error.code,
          hint: missing.error.hint,
          detail: missing.error.detail,
        },
      },
      importTransport: {
        status: importResponse.status,
        isArray: Array.isArray(imported),
      },
      scene: scene === undefined
        ? null
        : {
            entityCount: scene.payload?.entities?.length ?? 0,
            refCount: scene.refs?.length ?? 0,
          },
    };
  });
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'resonance-forge.png') });

  if (proof.health.reason !== 'alive') throw new Error(`renderer is not alive: ${JSON.stringify(proof.health)}`);
  if (
    proof.snapshot.nodeCount !== 28 ||
    proof.snapshot.outputCount !== 16 ||
    proof.snapshot.sceneCount !== 1
  ) {
    throw new Error(`unexpected runtime projection: ${JSON.stringify(proof.snapshot)}`);
  }
  if (proof.snapshot.elapsed <= before.elapsed) throw new Error('resonance animation did not advance');
  if (
    proof.rows.length !== EXPECTED_KINDS.length ||
    proof.packageUrls.length !== 1 ||
    proof.packageAssetCount !== EXPECTED_KINDS.length
  ) {
    throw new Error(`ScriptablePack publication is not atomic: ${JSON.stringify(proof)}`);
  }
  if (proof.scene?.entityCount !== 28 || proof.scene.refCount !== 9) {
    throw new Error(`generated SceneAsset closure is incomplete: ${JSON.stringify(proof.scene)}`);
  }
  if (
    !proof.assetRegistry.allLoaded ||
    proof.assetRegistry.loadedKinds.length !== proof.rows.length ||
    proof.assetRegistry.allKinds.join('|') !== [...EXPECTED_KINDS].sort().join('|') ||
    !proof.assetRegistry.memberProofComplete
  ) {
    throw new Error(`AssetRegistry dev ImportTransport closure is incomplete: ${JSON.stringify(proof.assetRegistry)}`);
  }
  if (
    proof.assetRegistry.missingFailure === null ||
    typeof proof.assetRegistry.missingFailure.code !== 'string' ||
    typeof proof.assetRegistry.missingFailure.hint !== 'string'
  ) {
    throw new Error(`AssetRegistry structured failure is incomplete: ${JSON.stringify(proof.assetRegistry.missingFailure)}`);
  }
  if (proof.importTransport.status !== 200 || !proof.importTransport.isArray) {
    throw new Error(`browser import transport is not a JSON Pack-index response: ${JSON.stringify(proof.importTransport)}`);
  }
  if (pageErrors.length > 0 || consoleErrors.length > 0 || badResponses.length > 0) {
    throw new Error(JSON.stringify({
      phase: 'browser-scriptable-pack-transport',
      pageErrors,
      consoleErrors,
      badResponses,
      importTransport: proof.importTransport,
    }));
  }
  console.log(JSON.stringify({
    status: 'ok',
    runtime: proof.snapshot,
    publication: { catalogRows: proof.rows.length, packageUrls: proof.packageUrls, packageAssetCount: proof.packageAssetCount },
    screenshot: resolve(ARTIFACT_DIR, 'resonance-forge.png'),
  }));
} finally {
  await browser.close();
  if (server.pid !== undefined) process.kill(-server.pid, 'SIGTERM');
  await sleep(100);
  if (server.exitCode === null && server.pid !== undefined) {
    try { process.kill(-server.pid, 'SIGKILL'); } catch {}
  }
  if (process.exitCode && serverOutput.length > 0) console.error(serverOutput);
}
