import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import { assertPortableRustArtifact, portableRustFlags } from '../../../scripts/lib/rust-build-paths.mjs';
import { gitHttpEnvironment } from '../../../scripts/lib/git-http-environment.mjs';
import { bundleRapierDeclarations } from './build-declarations.mjs';
import { buildSimdPayload } from './build-simd-payload.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dimension = process.argv.includes('--2d') ? '2d' : '3d';
const owner = resolve(root, `../physics-rapier${dimension}`);
const stem = `rapier_wasm${dimension}`;
const bindingsManifest = dimension === '2d' ? 'scripts/bindings-2d.Cargo.toml' : 'scripts/bindings.Cargo.toml';
const lockfile = dimension === '2d' ? 'scripts/Cargo-2d.lock' : 'scripts/Cargo.lock';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = JSON.parse(await readFile(join(root, 'scripts/source.json'), 'utf8'));
const inputs = [
  'package.json',
  'scripts/source.json',
  'scripts/build-wasm.mjs',
  'scripts/native-init.js',
  'scripts/build-declarations.mjs',
  'scripts/build-simd-payload.mjs',
  'scripts/native-tests.Cargo.toml',
  'scripts/native-tests.Cargo.lock',
  bindingsManifest,
  lockfile,
  '../../scripts/lib/rust-build-paths.mjs',
  '../../scripts/lib/git-http-environment.mjs',
  ...(dimension === '3d' ? (await readdir(join(root, 'patches'))).sort().map((name) => `patches/${name}`) : []),
];
const inputHashes = Object.fromEntries(
  await Promise.all(inputs.map(async (name) => [name, sha256(await readFile(join(root, name)))])),
);
const contentKey = sha256(JSON.stringify(inputHashes));
// The CI payload cache key prints this same value, so restore and verify
// can never disagree about which inputs a payload was built from.
if (process.argv.includes('--key')) {
  process.stdout.write(`${contentKey}\n`);
  process.exit(0);
}
const pkg = join(owner, 'pkg');
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`unexpected artifact: ${path}`);
  }
  return result.sort();
}
async function verify() {
  const receipt = JSON.parse(await readFile(join(pkg, 'provenance.json'), 'utf8'));
  if (receipt.contentKey !== contentKey) throw new Error('Rapier WASM source/patch key changed');
  const inventory = (await files(pkg)).filter((path) => path !== join(pkg, 'provenance.json'));
  if (inventory.length !== Object.keys(receipt.artifacts).length)
    throw new Error('Rapier WASM inventory changed');
  for (const path of inventory) {
    const name = relative(pkg, path).replaceAll('\\', '/');
    if (sha256(await readFile(path)) !== receipt.artifacts[name])
      throw new Error(`Rapier WASM hash mismatch: ${name}`);
  }
}
if (process.argv.includes('--verify')) {
  await verify();
  process.exit(0);
}
if (process.argv.includes('--ensure')) {
  try {
    await verify();
    process.exit(0);
  } catch (error) {
    process.stdout.write(`Rebuilding Rapier WASM: ${error.message}\n`);
  }
}
function run(command, args, cwd, extraEnv = {}) {
  if (command === 'git') args = ['-c', 'core.longpaths=true', ...args];
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
// Anonymous GitHub fetches can transiently answer 401/5xx under load; retry a
// bounded number of times and never fall back to an interactive prompt.
function fetchPinned(checkout, commit, environment) {
  const args = ['-c', 'core.longpaths=true', 'fetch', '--depth=1', 'origin', commit];
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync('git', args, {
      cwd: checkout,
      env: { ...environment, GIT_TERMINAL_PROMPT: '0' },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status === 0) return;
    if (attempt === 4) throw new Error(`git fetch ${commit} failed after ${attempt} attempts`);
    process.stdout.write(`git fetch ${commit} failed (attempt ${attempt}/4); retrying\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 15_000);
  }
}
function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} unavailable`);
  return result.stdout.trim();
}
// An installed toolchain alias is allowed only when its actual version matches the pin.
process.env.RUSTUP_TOOLCHAIN ??= source.rust;
const rustVersion = output('rustc', ['--version']);
const wasmPackVersion = output('wasm-pack', ['--version']);
if (
  rustVersion.split(' ')[1] !== source.rust ||
  wasmPackVersion !== `wasm-pack ${source.wasmPack}`
)
  throw new Error(
    `Install Rust ${source.rust} with wasm32-unknown-unknown and wasm-pack ${source.wasmPack}; got ${rustVersion}, ${wasmPackVersion}`,
  );
const cache = join(root, '.wasm-build');
const work = join(cache, contentKey);
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
for (const name of ['rapier', 'parry']) {
  const checkout = join(work, name);
  run('git', ['init', checkout], root);
  run('git', ['remote', 'add', 'origin', source[name].url], checkout);
  fetchPinned(checkout, source[name].commit, gitHttpEnvironment(root, source[name].url));
  run('git', ['checkout', '--detach', source[name].commit], checkout);
  // Preserve 2D's upstream behavior; the maintained solver patches belong to 3D.
  if (dimension === '3d') {
    run('git', ['apply', '--check', join(root, `patches/${name}.patch`)], checkout);
    run('git', ['apply', join(root, `patches/${name}.patch`)], checkout);
  }
}
const rapier = join(work, 'rapier');
if (process.argv.includes('--test-native')) {
  if (dimension !== '3d') throw new Error('shared geometry native tests are 3D');
  const tests = join(work, 'native-tests');
  await mkdir(tests, { recursive: true });
  await cp(join(root, 'scripts/native-tests.Cargo.toml'), join(tests, 'Cargo.toml'));
  await cp(join(root, 'scripts/native-tests.Cargo.lock'), join(tests, 'Cargo.lock'));
  run('cargo', ['test', '--locked', '--manifest-path', join(tests, 'Cargo.toml')], root, {
    CARGO_TARGET_DIR: join(cache, 'native-test-target'),
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '4',
  });
  process.exit(0);
}
const bindings = join(rapier, 'typescript');
await writeFile(
  join(bindings, 'Cargo.toml'),
  `[workspace]
resolver = "2"
members = ["builds/rapier${dimension}"]
[profile.release]
codegen-units = 1
strip = true
[patch.crates-io]
rapier3d = {path = "../crates/rapier3d"}
rapier2d = {path = "../crates/rapier2d"}
parry${dimension} = {path = "../../parry/crates/parry${dimension}"}
`,
);
await mkdir(join(bindings, `builds/rapier${dimension}`), { recursive: true });
await cp(join(root, bindingsManifest), join(bindings, `builds/rapier${dimension}/Cargo.toml`));
await cp(join(root, lockfile), join(bindings, 'Cargo.lock'));
run('cargo', ['fetch', '--locked', '--manifest-path', join(bindings, 'Cargo.toml')], root);
const wasm = join(work, 'wasm');
const targetDirectory = join(resolve(process.env.CARGO_TARGET_DIR ?? join(cache, 'target')), dimension);
run(
  'wasm-pack',
  ['build', '--target', 'web', '--release', '--out-dir', wasm, '--', '--locked'],
  join(bindings, `builds/rapier${dimension}`),
  {
    CARGO_ENCODED_RUSTFLAGS: portableRustFlags(resolve(root, '../..'), { ...process.env, CARGO_TARGET_DIR: targetDirectory }),
    CARGO_TARGET_DIR: targetDirectory,
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '4',
  },
);
const js = join(work, 'js');
async function copyTypescript(from, to) {
  await mkdir(to, { recursive: true });
  for (const item of await readdir(from, { withFileTypes: true })) {
    const a = join(from, item.name),
      b = join(to, item.name);
    if (item.isDirectory()) await copyTypescript(a, b);
    else
      await writeFile(
        b,
        (await readFile(a, 'utf8')).replace(new RegExp(`//\\s*#if DIM${dimension === '2d' ? 3 : 2}[\\s\\S]*?//\\s*#endif`, 'g'), ''),
      );
  }
}
await copyTypescript(join(bindings, 'src.ts'), js);
for (const name of [`${stem}.js`, `${stem}.d.ts`, `${stem}_bg.wasm`])
  await cp(join(wasm, name), join(js, name));
await writeFile(join(js, 'raw.ts'), `export * from "./${stem}.js";\n`);
await writeFile(
  join(js, 'init.ts'),
  `import initWasm from "./${stem}.js";\nimport bytes from "./${stem}_bg.wasm";\nexport async function init() { await initWasm({module_or_path:bytes}); }\n`,
);
await writeFile(
  join(js, 'wasm.d.ts'),
  'declare module "*.wasm" { const bytes: Uint8Array; export default bytes; }\n',
);
const staged = join(work, 'pkg');
await mkdir(staged, { recursive: true });
await build({
  entryPoints: [join(js, 'rapier.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile: join(staged, 'rapier.mjs'),
  loader: { '.wasm': 'binary' },
  legalComments: 'eof',
  minify: true,
});
// Both transports use the same freshly compiled WASM and generated ABI wrappers.
// The native transport replaces only the browser loader with an explicit Host.
const wasmBytes = await readFile(join(wasm, `${stem}_bg.wasm`));
assertPortableRustArtifact(wasmBytes);
const glue = await readFile(join(wasm, `${stem}.js`), 'utf8');
const loaderBoundary = '\nasync function __wbg_load(module, imports) {';
if (
  glue.split(loaderBoundary).length !== 2 ||
  !glue.includes('function __wbg_finalize_init(instance, module) {') ||
  !glue.includes(`"./${stem}_bg.js": import0`) ||
  !glue.includes('__wbg_performance_3fcf6e32a7e1ed0a: function(arg0) {') ||
  !glue.includes('function addHeapObject(obj) {') ||
  glue.includes('__wbindgen_start')
)
  throw new Error('Rapier wasm-bindgen 0.2.121 glue changed; requalify the native initializer');
const wasmModule = new WebAssembly.Module(wasmBytes);
if (
  WebAssembly.Module.imports(wasmModule).some(
    (entry) => entry.module !== `./${stem}_bg.js`,
  ) ||
  WebAssembly.Module.exports(wasmModule).some((entry) => entry.name === '__wbindgen_start')
)
  throw new Error('Rapier native WASM import namespace or start ABI changed');
const nativeGlue = [
  "import { sha256 } from '@noble/hashes/sha2.js';",
  `export const artifact = Object.freeze(${JSON.stringify({ bytes: wasmBytes.length, sha256: sha256(wasmBytes) })});`,
  glue.slice(0, glue.indexOf(loaderBoundary)),
  (await readFile(join(root, 'scripts/native-init.js'), 'utf8')).replaceAll('rapier_wasm3d', stem),
].join('\n');
await build({
  stdin: {
    contents: `import RAPIER from './rapier.ts';\nimport { initializeNative } from './${stem}.js';\nexport { artifact } from './${stem}.js';\nexport async function initialize(host) { await initializeNative(host); return RAPIER; }\n`,
    resolveDir: js,
    sourcefile: 'rapier-native-entry.mjs',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile: join(staged, 'rapier-native.mjs'),
  external: ['@noble/hashes/sha2.js'],
  legalComments: 'eof',
  minify: true,
  plugins: [
    {
      name: 'rapier-native-host',
      setup(builder) {
        builder.onLoad({ filter: /rapier_wasm[23]d\.js$/ }, ({ path }) => {
          if (path !== join(js, `${stem}.js`)) return;
          return { contents: nativeGlue, resolveDir: root };
        });
        builder.onLoad({ filter: /init\.ts$/ }, ({ path }) => {
          if (path !== join(js, 'init.ts')) return;
          return {
            contents: `export { initializeNative as init } from './${stem}.js';\n`,
            resolveDir: js,
          };
        });
      },
    },
  ],
});
await cp(join(wasm, `${stem}_bg.wasm`), join(staged, 'rapier.wasm'));
await writeFile(
  join(staged, 'rapier-native.d.mts'),
  "export declare const artifact: {readonly bytes:number;readonly sha256:string};\nexport declare function initialize(host: import('@forgeax/engine-physics').PhysicsWasmHost): Promise<unknown>;\n",
);
const declarations = join(work, 'declarations');
const tsconfig = join(work, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: {
      strict: false,
      skipLibCheck: true,
      target: 'es2022',
      module: 'esnext',
      moduleResolution: 'bundler',
      declaration: true,
      emitDeclarationOnly: true,
      outDir: declarations,
      rootDir: js,
    },
    include: [join(js, 'rapier.ts'), join(js, 'wasm.d.ts')],
  }),
);
run('node', [fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', tsconfig], root);
await cp(join(wasm, `${stem}.d.ts`), join(declarations, `${stem}.d.ts`));
await bundleRapierDeclarations(declarations, staged, tsconfig);
if (dimension === '3d') await buildSimdPayload({ root, work, bindings, staged, cache, run });
await cp(join(bindings, 'LICENSE'), join(staged, 'LICENSE'));
const artifacts = Object.fromEntries(
  await Promise.all(
    (await files(staged)).map(async (path) => [
      relative(staged, path).replaceAll('\\', '/'),
      sha256(await readFile(path)),
    ]),
  ),
);
await writeFile(
  join(staged, 'provenance.json'),
  JSON.stringify(
    {
      contentKey,
      inputHashes,
      source,
      toolchain: { rustVersion, wasmPackVersion, wasmBindgen: '0.2.121', esbuildVersion },
      artifacts,
    },
    null,
    2,
  ) + '\n',
);
await rm(pkg, { recursive: true, force: true });
await rename(staged, pkg);
await verify();
process.stdout.write(`Rapier WASM built and verified: ${contentKey}\n`);
