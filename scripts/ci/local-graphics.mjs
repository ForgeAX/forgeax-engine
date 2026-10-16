#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrowserCommand } from './run-browser-gate-with-retry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const lockBytes = readFileSync(join(here, 'local-graphics.lock.json'));
const lock = JSON.parse(lockBytes);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const { libraryDirectory, icdPath } = lock;
const hostGlibc = () => process.report.getReport().header.glibcVersionRuntime ?? '0.0';

// Hosts at the prebuilt Ubuntu closure's glibc floor extract it; older hosts
// compile the same SHA-256-pinned Mesa release against their own glibc/LLVM.
export function selectProducer(glibc = hostGlibc()) {
  const [major, minor] = glibc.split('.').map(Number);
  const [requiredMajor, requiredMinor] = lock.minimumGlibc.split('.').map(Number);
  return major > requiredMajor || (major === requiredMajor && minor >= requiredMinor)
    ? 'prebuilt'
    : 'source';
}

const producerLibraries = (producer) =>
  producer === 'prebuilt' ? lock.libraries : lock.source.libraries;

export function bundlePath(env = process.env, producer = selectProducer()) {
  const id = producer === 'prebuilt' ? lock.id : `${lock.source.id}-glibc${hostGlibc()}`;
  return resolve(
    env.FORGEAX_CI_GRAPHICS_ROOT ??
      join(
        env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
        'forgeax',
        'graphics',
        `${id}-${digest(lockBytes).slice(0, 12)}`,
      ),
  );
}

export function graphicsEnvironment(bundle, environment = process.env) {
  const icd = join(bundle, icdPath);
  return {
    ...environment,
    VK_ICD_FILENAMES: icd,
    VK_DRIVER_FILES: icd,
    LD_LIBRARY_PATH:
      join(bundle, libraryDirectory) +
      (environment.LD_LIBRARY_PATH ? `:${environment.LD_LIBRARY_PATH}` : ''),
    LP_NUM_THREADS: environment.LP_NUM_THREADS ?? '4',
    CI: environment.CI ?? '1',
  };
}

export function verifyArchive(bytes, expected) {
  if (digest(bytes) !== expected)
    throw new Error('graphics-integrity: downloaded package SHA-256 mismatch; nothing extracted');
}

function checkHost() {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error(
      'graphics-host-unsupported: this bundle requires Linux x64; use the host graphics stack instead',
    );
}

function installedFiles(bundle, producer) {
  return Object.fromEntries(
    [icdPath, ...producerLibraries(producer).map((name) => join(libraryDirectory, name))].map(
      (path) => [path, digest(readFileSync(join(bundle, path)))],
    ),
  );
}

export function verifyBundle(bundle, producer = selectProducer()) {
  try {
    const receipt = JSON.parse(readFileSync(join(bundle, 'receipt.json')));
    if (
      receipt.lock !== digest(lockBytes) ||
      receipt.producer !== producer ||
      JSON.stringify(receipt.files) !== JSON.stringify(installedFiles(bundle, producer))
    )
      throw new Error('receipt mismatch');
  } catch (cause) {
    throw new Error(
      `graphics-bundle-unavailable: ${bundle}; run pnpm ci:graphics setup (remove a corrupt bundle first)`,
      { cause },
    );
  }
}

// curl carries a bounded network lifetime; no system package manager or sudo.
function download(entry, archive) {
  console.log(`[graphics-setup] ${entry.url}`);
  execFileSync(
    'curl',
    [
      '--fail',
      '--location',
      '--silent',
      '--show-error',
      '--max-time',
      '180',
      '--output',
      archive,
      entry.url,
    ],
    { stdio: 'inherit' },
  );
  verifyArchive(readFileSync(archive), entry.sha256);
}

function extractPrebuilt(staging) {
  for (const entry of lock.packages) {
    const archive = join(staging, `${entry.name}.deb`);
    download(entry, archive);
    const compressed = execFileSync('ar', ['p', archive, 'data.tar.zst'], {
      maxBuffer: 128 * 1024 * 1024,
    });
    execFileSync('tar', ['--zstd', '-xf', '-', '-C', join(staging, 'root')], {
      input: compressed,
    });
    rmSync(archive);
  }
}

function buildFromSource(staging) {
  const missing = ['meson', 'ninja', 'glslangValidator'].filter(
    (tool) => spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status !== 0,
  );
  if (missing.length)
    throw new Error(
      `graphics-source-prerequisites: glibc ${hostGlibc()} < ${lock.minimumGlibc} builds Lavapipe from source; missing ${missing.join(', ')} (also needs llvm-config, bison, flex, pkg-config, Python mako/PyYAML)`,
    );
  const archive = join(staging, 'mesa.tar.xz');
  const source = join(staging, 'src');
  const build = join(staging, 'build');
  download(lock.source, archive);
  mkdirSync(source);
  execFileSync('tar', ['-xJf', archive, '-C', source, '--strip-components=1']);
  rmSync(archive);
  const run = (args) => execFileSync('meson', args, { stdio: 'inherit' });
  run([
    'setup',
    build,
    source,
    '--prefix=/usr',
    `--libdir=${libraryDirectory.slice('root/usr/'.length)}`,
    ...lock.source.mesonOptions,
  ]);
  run(['compile', '-C', build]);
  run(['install', '-C', build, '--no-rebuild', '--destdir', join(staging, 'root')]);
  rmSync(build, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
  // Mesa writes an absolute system library_path; the bundle resolves its own
  // driver through LD_LIBRARY_PATH, matching the prebuilt Ubuntu manifest.
  const icdDirectory = dirname(join(staging, icdPath));
  const installed = readdirSync(icdDirectory).find((name) => /^lvp_icd\..+\.json$/.test(name));
  if (!installed) throw new Error('graphics-source-build: Mesa installed no Lavapipe ICD manifest');
  const manifest = JSON.parse(readFileSync(join(icdDirectory, installed)));
  manifest.ICD.library_path = 'libvulkan_lvp.so';
  writeFileSync(join(staging, icdPath), `${JSON.stringify(manifest, null, 4)}\n`);
  rmSync(join(icdDirectory, installed));
}

export async function setupGraphics(
  producer = selectProducer(),
  bundle = bundlePath(process.env, producer),
) {
  checkHost();
  if (existsSync(bundle)) {
    verifyBundle(bundle, producer);
    return bundle;
  }
  mkdirSync(dirname(bundle), { recursive: true });
  const staging = mkdtempSync(join(dirname(bundle), '.graphics-'));
  try {
    mkdirSync(join(staging, 'root'));
    if (producer === 'prebuilt') extractPrebuilt(staging);
    else buildFromSource(staging);
    const receipt = { lock: digest(lockBytes), producer, files: installedFiles(staging, producer) };
    writeFileSync(join(staging, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    try {
      renameSync(staging, bundle);
    } catch (error) {
      // A concurrent setup on a shared cache may publish first; its receipt decides.
      if (!existsSync(bundle)) throw error;
    }
    verifyBundle(bundle, producer);
    return bundle;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function parseGraphicsArgs(argv) {
  const args = [...argv];
  const action = ['setup', 'probe'].includes(args[0]) ? args.shift() : 'run';
  let probe = 'both';
  if (args[0] === '--probe') {
    args.shift();
    probe = args.shift();
  }
  if (!['dawn', 'browser', 'both'].includes(probe))
    throw new Error('graphics-usage: --probe dawn|browser|both');
  const command = action === 'run' && args.shift() === '--' ? args.splice(0) : [];
  if (
    args.length ||
    (action === 'run' && !command.length) ||
    (action === 'setup' && probe !== 'both')
  )
    throw new Error(
      'usage: pnpm ci:graphics setup | probe [--probe dawn|browser|both] | [--probe dawn|browser|both] -- COMMAND [ARGS...]',
    );
  return { action, probe, command };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseGraphicsArgs(argv);
  const bundle = bundlePath();
  checkHost();
  if (options.action === 'setup') {
    console.log(`[graphics-setup] ready (${selectProducer()}): ${await setupGraphics()}`);
    return 0;
  }
  verifyBundle(bundle);
  const env = graphicsEnvironment(bundle);
  const backends = options.probe === 'both' ? ['dawn', 'browser'] : [options.probe];
  for (const backend of backends) {
    const result = await runBrowserCommand(
      [process.execPath, join(here, 'probe-local-graphics.mjs'), backend],
      { env, label: `graphics-preflight-${backend}`, timeoutMs: 60_000 },
    );
    if (result.status !== 0) return result.status;
  }
  if (options.action === 'probe') return 0;
  console.log('[graphics] software validation only; command coverage and assertions are unchanged');
  return (await runBrowserCommand(options.command, { env, label: 'local-software-graphics' }))
    .status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
