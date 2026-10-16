import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const channels = ['ts', 'executable', 'config'];
const rules = [
  ['renderer.ready', 'T-M6-04', 'packages/app/src/create-app.ts'],
  ['renderer.device', 'T-M6-04', 'packages/app/src/create-app.ts'],
  ['renderer.store', 'T-M6-04', 'packages/app/src/create-app.ts'],
  ['renderer.assets', 'T-M6-04', 'packages/app/src/create-app.ts'],
  ['renderer.readPixels', 'T-M6-04', 'packages/app/src/create-app.ts'],
  ['renderer.observeCurrentFrame', 'T-M6-04', 'packages/app/src/create-app.ts'],
  ['renderer.installRenderFeature', 'T-M6-04', 'packages/render/src/render-contract.ts'],
  ['renderer.uninstallRenderFeature', 'T-M6-04', 'packages/render/src/render-contract.ts'],
  ['renderer.attachWorld', 'T-M6-04', 'packages/app/src/create-app.ts'],
  ['renderer.detachWorld', 'T-M6-04', 'packages/app/src/create-app.ts'],
  ['renderer.registerPipeline', 'T-M6-04', 'packages/render/src/render-contract.ts'],
  ['renderer.postProcess', 'T-M6-04', 'packages/render/src/render-contract.ts'],
  ['RendererCreateOptions', 'T-M6-04', 'packages/runtime/src/createRenderer.ts'],
  ['RendererBackend', 'T-M6-04', 'packages/render/src/render-contract.ts'],
  ['GpuResourceStore', 'T-M6-04', 'packages/render/src/render-contract.ts'],
  ['TONEMAP_POST_PROCESS_ID', 'T-M6-04', 'packages/render/src/render-graph-primitives.ts'],
  ['readRenderLease', 'T-M6-04', 'packages/render/src/render-contract.ts'],
  ['renderer.renderReadLease', 'T-M6-04', 'packages/render/src/render-contract.ts'],
  ['rawDevice', 'T-M6-04', 'packages/render/src/render-contract.ts'],
  ['rawQueue', 'T-M6-04', 'packages/render/src/render-contract.ts'],
  ['rawEncoder', 'T-M6-04', 'packages/render/src/render-contract.ts'],
  ['render-v2', 'T-M6-04', 'packages/render/src/render-contract.ts'],
  ['host.device', 'T-M6-04', 'packages/app/src/internal/debug-draw.ts'],
  ['host.assetRegistry', 'T-M6-04', 'packages/render/src/assembly/host-contract.ts'],
  ['host._internal_', 'T-M6-04', 'packages/render/src/assembly/host-contract.ts'],
];

// RHI implementations own these raw names at the backend boundary. This is
// deliberately path- and token-scoped: an app, runtime, render, or script hit
// remains a failure, and a new backend path is not silently admitted.
const RHI_RAW_HANDLE_TOKENS = new Set(['rawDevice', 'rawQueue', 'rawEncoder']);
const RHI_OWNER_PREFIXES = [
  'packages/rhi-webgpu/src/',
  'packages/rhi-wgpu/src/',
  'packages/wgpu-wasm/pkg/',
  'apps/hello/debug-draw/',
  'apps/hello/cube/scripts/',
  'apps/hello/triangle/scripts/',
  'apps/dual-impl-spike/',
];
const RHI_PROBE_PREFIXES = [
  'apps/hello/m3-programmable-rendering/',
  'apps/learn-render/1.getting-started/2.hello-triangle/src/r5-probe.ts',
];

export function isRhiOwnedRawHandle(relativePath, token) {
  if (
    token === 'host.device' &&
    RHI_PROBE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  ) {
    return true;
  }
  return (
    RHI_RAW_HANDLE_TOKENS.has(token) &&
    RHI_OWNER_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  );
}

const channelExtensions = {
  ts: new Set(['.ts', '.tsx']),
  executable: new Set(['.js', '.mjs', '.cjs', '.sh']),
  config: new Set(['.json', '.jsonc', '.yaml', '.yml']),
};

function ignored(path) {
  const normalized = path.split(sep).join('/');
  return (
    normalized.includes('/node_modules/') ||
    normalized.includes('/dist/') ||
    normalized.includes('/.git/') ||
    normalized.includes('/.forgeax-harness/') ||
    normalized.includes('/__tests__/') ||
    normalized.includes('.test.') ||
    normalized.includes('.spec.') ||
    normalized.endsWith('/render-consumer-inventory.mjs')
  );
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function channelFor(path) {
  const extension = path.slice(path.lastIndexOf('.'));
  return channels.find((channel) => channelExtensions[channel].has(extension));
}

const roots = ['apps', 'packages', 'scripts'].map((directory) => join(root, directory));
const hits = [];
const ownerExcluded = [];
for (const directory of roots) {
  for (const path of walk(directory)) {
    if (ignored(path)) continue;
    const channel = channelFor(path);
    if (channel === undefined) continue;
    const source = readFileSync(path, 'utf8');
    const relativePath = relative(root, path).split(sep).join('/');
    const lines = source.split(/\r?\n/);
    for (const [token, ownerTask, ...targetFiles] of rules) {
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(token)) continue;
        const hit = {
          channel,
          path: relativePath,
          line: index + 1,
          token,
          ownerTask,
          targetFiles,
        };
        if (isRhiOwnedRawHandle(relativePath, token)) ownerExcluded.push(hit);
        else hits.push(hit);
      }
    }
  }
}

export const report = {
  channels,
  baseline: {
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  },
  hits,
  ownerExcluded,
  summary: {
    total: hits.length,
    ownerExcluded: ownerExcluded.length,
    byChannel: Object.fromEntries(
      channels.map((channel) => [channel, hits.filter((hit) => hit.channel === channel).length]),
    ),
  },
};

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`render consumer inventory: ${report.summary.total} hit(s)\n`);
    for (const hit of hits)
      process.stdout.write(`${hit.channel} ${hit.path}:${hit.line} ${hit.token}\n`);
  }

  process.exitCode = hits.length === 0 ? 0 : 1;
}
