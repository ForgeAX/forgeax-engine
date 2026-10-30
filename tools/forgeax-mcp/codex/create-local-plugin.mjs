#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { copyRuntime } from './copy-runtime.mjs';
import { APP_VERSION, MCP_SERVERS, VIEW_TITLE } from '../src/contract.ts';

const [projectArg, outputArg] = process.argv.slice(2);
if (!projectArg || !outputArg) {
  console.error(
    'Usage: node create-local-plugin.mjs <trusted-project-root> <new-marketplace-directory>',
  );
  process.exit(2);
}

const projectRoot = await realpath(resolve(projectArg));
const project = JSON.parse(await readFile(join(projectRoot, 'forge.json'), 'utf8'));
if (!project || typeof project !== 'object' || typeof project.id !== 'string')
  throw new TypeError('The project root must contain a valid forge.json identity.');

const marketplaceRoot = resolve(outputArg);
const pluginName = 'forgeax-view-codex';
const marketplaceName = `forgeax-view-local-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 12)}`;
const pluginRoot = join(marketplaceRoot, 'plugins', pluginName);
// A local plugin contains one exact project binding. Never overwrite another
// installed package or silently change the root an existing Codex tool reads.
await mkdir(marketplaceRoot);
await mkdir(pluginRoot, { recursive: true });
await mkdir(join(marketplaceRoot, '.agents', 'plugins'), { recursive: true });

const writeJson = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const nodeCommand = process.platform === 'win32' ? 'node' : './node-launcher';
if (process.platform !== 'win32') {
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(pluginRoot, 'node-launcher'),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`,
    { mode: 0o700 },
  );
}
await build({
  entryPoints: [join(import.meta.dirname, '../src/mcp-stdio.mjs')],
  outfile: join(pluginRoot, 'mcp-stdio.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  logLevel: 'silent',
});
// Native compiler packages resolve their own platform binary and filesystem paths.
const appRuntimePackages = ['vite', 'typescript', 'esbuild'];
await build({
  entryPoints: {
    'src/codex-app-server': join(import.meta.dirname, '../src/codex-app-server.mjs'),
    'src/app/program-bundler': join(import.meta.dirname, '../src/app/program-bundler.mjs'),
  },
  outdir: pluginRoot,
  outExtension: { '.js': '.mjs' },
  splitting: true,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'bundle',
  external: appRuntimePackages,
  logLevel: 'silent',
  banner: {
    js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);",
  },
});
await copyRuntime(resolve(import.meta.dirname, '..'), pluginRoot, appRuntimePackages);
await mkdir(join(pluginRoot, 'dist'), { recursive: true });
for (const name of ['carrier.html', 'full-view.html', 'codex-view.html', 'preview-runtime.mjs'])
  await cp(join(import.meta.dirname, '../dist', name), join(pluginRoot, 'dist', name));
await writeJson(join(pluginRoot, 'plugin.json'), {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: pluginName,
  version: APP_VERSION,
  description: 'Optional ForgeAX View App and Engine workspace tools for one trusted project.',
});
await writeJson(join(pluginRoot, 'mcp.json'), {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: {
    [MCP_SERVERS.tools]: {
      type: 'stdio',
      command: nodeCommand,
      args: ['${PLUGIN_ROOT}/mcp-stdio.mjs', projectRoot],
    },
    [MCP_SERVERS.view]: {
      type: 'stdio',
      command: nodeCommand,
      args: ['${PLUGIN_ROOT}/src/codex-app-server.mjs', projectRoot],
    },
  },
});
await writeJson(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
  name: marketplaceName,
  interface: { displayName: `${VIEW_TITLE} (local)` },
  plugins: [
    {
      name: pluginName,
      source: { source: 'local', path: `./plugins/${pluginName}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    },
  ],
});
console.log(JSON.stringify({ marketplaceRoot, marketplaceName, pluginName, projectRoot }));
