/**
 * Render the standalone SDK launcher.
 *
 * The launcher is emitted into the SDK archive, so it cannot import the
 * contributor checkout at runtime. Keep its platform boundary here as the
 * single source used by the archive builder and its contract tests.
 */
export function sdkLauncherSource(packageManager) {
  const packageManagerName = packageManager.split('@', 1)[0];
  if (packageManagerName !== 'pnpm') throw new Error('sdk-package-manager-invalid');
  return `#!/usr/bin/env node
import { access, cp, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const sdkRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const runtimeRoot = resolve(sdkRoot, '.forgeax', 'cli-runtime');
const engineBin = resolve(runtimeRoot, 'node_modules', '@forgeax', 'engine', 'dist', 'bin', 'forgeax.mjs');
const runtimeFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const packageManager = ${JSON.stringify(packageManager)};
const packageManagerName = ${JSON.stringify(packageManagerName)};

function corepackAvailable() {
  if (process.platform === 'win32') {
    const comSpec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    return spawnSync(comSpec, ['/d', '/s', '/c', 'where', 'corepack'], { stdio: 'ignore' }).status === 0;
  }
  return spawnSync('corepack', ['--version'], { stdio: 'ignore' }).status === 0;
}

function packageManagerInvocation(command, args) {
  if (process.platform !== 'win32') return { file: command, args };
  const comSpec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
  return { file: comSpec, args: ['/d', '/s', '/c', command, ...args] };
}

function installWithPackageManager(args) {
  const useCorepack = corepackAvailable();
  const command = useCorepack ? 'corepack' : packageManagerName;
  const commandArgs = useCorepack ? [packageManager, ...args] : args;
  const invocation = packageManagerInvocation(command, commandArgs);
  return spawnSync(invocation.file, invocation.args, {
    cwd: runtimeRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function runtimeReady() {
 try {
  await access(engineBin);
  for (const file of runtimeFiles) {
   if (!(await readFile(resolve(runtimeRoot, file))).equals(await readFile(resolve(sdkRoot, 'toolchain', 'cli-runtime', file)))) return false;
  }
  await access(resolve(runtimeRoot, 'node_modules/@forgeax/view/host.pack.json'));
  createRequire(resolve(runtimeRoot, 'package.json')).resolve('@forgeax/view/host.pack.json');
  return true;
 } catch { return false; }
}
if (!await runtimeReady()) {
  await mkdir(runtimeRoot, { recursive: true });
  for (const file of runtimeFiles) await cp(resolve(sdkRoot, 'toolchain', 'cli-runtime', file), resolve(runtimeRoot, file));
  const storeDir = resolve(sdkRoot, 'store', 'pnpm');
  const args = ['install', '--frozen-lockfile', '--ignore-scripts'];
  const offline = await access(storeDir).then(() => true, () => false);
  if (offline) args.push('--store-dir', storeDir, '--offline');
  // Online carrier bootstrap uses the package manager cache; only the ZIP
  // supplies store/pnpm. Creating that path online would misclassify a partial
  // CLI cache as the complete offline template closure.
  const result = installWithPackageManager(args);
  if (result.error) { console.error(result.error); process.exit(1); }
  if (result.status !== 0) { if (result.stdout) process.stderr.write(result.stdout); process.exit(result.status ?? 1); }
  if (!await runtimeReady()) { console.error('sdk-tool-runtime-incomplete'); process.exit(1); }
}
const argv = process.argv.slice(2);
if (['backend', 'view'].includes(argv[0]) && !argv.includes('--root')) process.argv.push('--root', runtimeRoot);
if (argv[0] === 'backend' && argv[1] === 'start' && !argv.includes('--host-pack')) {
 const hostPack = createRequire(resolve(runtimeRoot, 'package.json')).resolve('@forgeax/view/host.pack.json');
 process.argv.push('--host-pack', hostPack);
}
await import(pathToFileURL(engineBin).href);
`;
}
