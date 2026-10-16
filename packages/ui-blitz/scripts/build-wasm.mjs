import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPortableRustArtifact, portableRustFlags } from '../../../scripts/lib/rust-build-paths.mjs';
import { resolveAsset, sha256 } from './content-key.mjs';
import { installBundle, outputFacts, verifyProvenance } from './provenance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = resolve(root, '../..');
const fork = join(engine, 'third_party/blitz');
const cargo = process.env.CARGO ?? 'cargo';
const bindgen = process.env.WASM_BINDGEN ?? 'wasm-bindgen';
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options });
// The release recipe belongs to the hashed source, not per-process overrides.
const overrides = Object.keys(process.env).filter(
  (name) =>
    process.env[name] &&
    /^(?:RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC(?:_WRAPPER|_WORKSPACE_WRAPPER)?|CARGO_BUILD_(?:RUSTFLAGS|RUSTC(?:_WRAPPER|_WORKSPACE_WRAPPER)?)|CARGO_TARGET_.*_(?:RUSTFLAGS|LINKER)|CARGO_PROFILE_.*)$/.test(
      name,
    ),
);
if (overrides.length > 0)
  throw new Error(`Unsupported UI WASM build recipe overrides: ${overrides.sort().join(', ')}`);
const source = await resolveAsset();
// Cargo releases its lock before bindgen. Different sources must never share
// the flat cdylib output, even when callers reuse CARGO_TARGET_DIR as a cache.
const target = join(resolve(root, process.env.CARGO_TARGET_DIR ?? 'target'), source.sha256);

if (run(bindgen, ['--version']).trim() !== 'wasm-bindgen 0.2.129') {
  throw new Error('UI binding requires wasm-bindgen 0.2.129; requalify any ABI change');
}
run(
  cargo,
  [
    '+1.99.0',
    'build',
    '--locked',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '--target-dir',
    target,
  ],
  { stdio: 'inherit', env: { ...process.env,
    CARGO_ENCODED_RUSTFLAGS: portableRustFlags(engine, { ...process.env, CARGO_TARGET_DIR: target }),
  } },
);
const pkg = await mkdtemp(join(root, '.pkg-build-'));
try {
  run(bindgen, [
    '--target',
    'web',
    '--out-name',
    'ui_blitz',
    '--out-dir',
    pkg,
    join(target, 'wasm32-unknown-unknown/release/forgeax_ui_blitz.wasm'),
  ]);
  const wasm = await readFile(join(pkg, 'ui_blitz_bg.wasm'));
  assertPortableRustArtifact(wasm);
  const glue = await readFile(join(pkg, 'ui_blitz.js'), 'utf8');
  const declarations = await readFile(join(pkg, 'ui_blitz.d.ts'), 'utf8');
  const boundary = '\nasync function __wbg_load(module, imports) {';
  const declarationBoundary = '\nexport type InitInput =';
  if (
    glue.split(boundary).length !== 2 ||
    !glue.includes('function __wbg_finalize_init(instance, module) {') ||
    declarations.split(declarationBoundary).length !== 2
  ) {
    throw new Error('UI bindgen shape changed; inspect native imports and requalify the generator');
  }
  const initializer = await readFile(join(root, 'scripts/native-init.js'), 'utf8');
  const derived = [
    "import { sha256 } from '@noble/hashes/sha2.js';",
    `const artifact = ${JSON.stringify({ bytes: wasm.length, sha256: sha256(wasm) })};`,
    glue.slice(0, glue.indexOf(boundary)),
    initializer,
  ].join('\n');
  const nativeDeclarations =
    declarations.slice(0, declarations.indexOf(declarationBoundary)) +
    '\nexport declare function initialize(host: import("../src/wasm-host.js").UiWasmHost): Promise<void>;\n';
  await writeFile(join(pkg, 'ui-native.mjs'), derived);
  await writeFile(join(pkg, 'ui-native.d.mts'), nativeDeclarations);
  const metadata = JSON.parse(
    run(cargo, ['+1.99.0', 'metadata', '--locked', '--format-version', '1']),
  );
  const resolved = metadata.resolve.nodes
    .map((node) => ({ id: node.id, features: node.features }))
    .filter((node) => !node.id.startsWith('path+'));
  let forkRevision = null,
    forkDirty = null;
  if (existsSync(join(fork, '.git'))) {
    forkRevision = run('git', ['-C', fork, 'rev-parse', 'HEAD']).trim();
    forkDirty = run('git', ['-C', fork, 'status', '--porcelain']).trim() !== '';
  } else {
    // The SDK archives exact sources without Git. Retain original revision
    // metadata only when the complete fork inputs still match its checked receipt.
    try {
      const original = await verifyProvenance({ expectedSourceDigest: source.sha256 });
      forkRevision = original.forkRevision;
      forkDirty = original.forkDirty;
    } catch {
      /* Modified archive: content identity remains authoritative. */
    }
  }
  const receipt = {
    schema: 'forgeax-ui-blitz/2',
    upstreamBase: '74fe1abf090732524c86d96e6cdb6f95d8f8d6dc',
    forkRevision,
    forkDirty,
    rust: run(cargo, ['+1.99.0', '--version']).trim(),
    wasmBindgen: '0.2.129',
    paint: 'vello_gpu@0.3.0/portable; anyrender_vello_cpu@0.18.0/reference',
    profile: 'release',
    sourceDigest: source.sha256,
    inputs: source.inputs,
    resolved,
    outputs: await outputFacts(pkg),
  };
  await writeFile(join(pkg, 'provenance.json'), JSON.stringify(receipt, null, 2) + '\n');
  // Reject changes during compilation before replacing the last usable bundle.
  await verifyProvenance({ pkgDirectory: pkg });
  await installBundle(pkg, root);
  process.stdout.write(
    JSON.stringify({
      wasmBytes: wasm.length,
      sourceDigest: receipt.sourceDigest,
      forkDirty: receipt.forkDirty,
    }) + '\n',
  );
} finally {
  await rm(pkg, { recursive: true, force: true });
}
