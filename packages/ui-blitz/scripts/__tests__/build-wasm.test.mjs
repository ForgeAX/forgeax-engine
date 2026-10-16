import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { resolveAsset } from '../content-key.mjs';
import { verifyProvenance } from '../provenance.mjs';

const execute = promisify(execFile);

// Controlled compiler processes exercise the real generation/provenance entry.
// A's binder starts only after A's compiler exits. B then replaces the artifact
// before A's binder reads it, exposing the window outside Cargo's target lock.
async function waitFor(name) {
  const fs = await import('node:fs/promises');
  const { join } = await import('node:path');
  const deadline = Date.now() + 8_000;
  while (
    !(await fs.access(join(process.env.FORGEAX_TEST_COORDINATION, name)).then(
      () => true,
      () => false,
    ))
  ) {
    if (Date.now() > deadline) throw new Error('build fixture barrier timed out: ' + name);
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function compiler() {
  const fs = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  if (process.argv.includes('metadata')) {
    process.stdout.write(JSON.stringify({ resolve: { nodes: [] } }));
    return;
  }
  if (process.argv.includes('--version')) {
    process.stdout.write('cargo 1.99.0 fixture');
    return;
  }
  const option = process.argv.indexOf('--target-dir');
  const target = resolve(
    option === -1 ? (process.env.CARGO_TARGET_DIR ?? 'target') : process.argv[option + 1],
  );
  const artifact = join(target, 'wasm32-unknown-unknown/release/forgeax_ui_blitz.wasm');
  const source = await fs.readFile('rust/lib.rs');
  const payload = Buffer.concat([Buffer.from([4]), Buffer.from('test'), source]);
  const bytes = Buffer.concat([
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, payload.length]),
    payload,
  ]);
  if (process.env.FORGEAX_TEST_ROLE === 'B') await waitFor('a-before-bindgen');
  await fs.mkdir(join(target, 'wasm32-unknown-unknown/release'), { recursive: true });
  await fs.writeFile(artifact, bytes);
  await fs.writeFile('compiler-target.json', JSON.stringify({ target, flags: process.env.CARGO_ENCODED_RUSTFLAGS }));
  if (process.env.FORGEAX_TEST_ROLE === 'B') {
    await fs.writeFile(join(process.env.FORGEAX_TEST_COORDINATION, 'b-ready'), '');
  }
}

async function binder() {
  const fs = await import('node:fs/promises');
  const { join } = await import('node:path');
  if (process.argv.includes('--version')) {
    process.stdout.write('wasm-bindgen 0.2.129');
    return;
  }
  const out = process.argv[process.argv.indexOf('--out-dir') + 1];
  if (process.env.FORGEAX_TEST_ROLE === 'A') {
    await fs.writeFile(join(process.env.FORGEAX_TEST_COORDINATION, 'a-before-bindgen'), '');
    await waitFor('b-ready');
  }
  const bytes = await fs.readFile(process.argv.at(-1));
  await fs.writeFile(join(out, 'ui_blitz_bg.wasm'), bytes);
  await fs.writeFile(
    join(out, 'ui_blitz_bg.wasm.d.ts'),
    'export const memory: WebAssembly.Memory;',
  );
  await fs.writeFile(
    join(out, 'ui_blitz.js'),
    'function __wbg_finalize_init(instance, module) {}\nasync function __wbg_load(module, imports) {}',
  );
  await fs.writeFile(
    join(out, 'ui_blitz.d.ts'),
    'export class UiDocument {}\nexport type InitInput = BufferSource;',
  );
}

async function fixture(t, sameSource = false) {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-ui-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tools = {};
  for (const [name, implementation] of [
    ['cargo', compiler],
    ['bindgen', binder],
  ]) {
    tools[name] = join(directory, name);
    await writeFile(
      tools[name],
      '#!/usr/bin/env node\n' +
        waitFor.toString() +
        '\n(' +
        implementation.toString() +
        ')().catch(error => { console.error(error); process.exitCode = 1; });\n',
    );
    await chmod(tools[name], 0o755);
  }
  const roots = [];
  for (const role of ['A', 'B']) {
    const engine = join(directory, role);
    const root = join(engine, 'packages/ui-blitz');
    await mkdir(join(engine, 'scripts/lib'), { recursive: true });
    await cp(new URL('../../../../scripts/lib/rust-build-paths.mjs', import.meta.url), join(engine, 'scripts/lib/rust-build-paths.mjs'));
    roots.push(root);
    for (const path of ['rust', 'scripts', 'vendor'])
      await mkdir(join(root, path), { recursive: true });
    for (const path of ['packages', 'vendor'])
      await mkdir(join(engine, 'third_party/blitz', path), { recursive: true });
    for (const path of ['Cargo.toml', 'Cargo.lock']) await writeFile(join(root, path), path);
    await writeFile(join(engine, 'third_party/blitz/Cargo.toml'), 'fixture');
    await writeFile(join(root, 'rust/lib.rs'), sameSource ? 'same source' : 'source ' + role);
    for (const name of ['build-wasm.mjs', 'content-key.mjs', 'provenance.mjs', 'native-init.js'])
      await cp(new URL('../' + name, import.meta.url), join(root, 'scripts', name));
  }
  const build = (index, target, extra = {}) => {
    const env = {
      ...process.env,
      CARGO: tools.cargo,
      WASM_BINDGEN: tools.bindgen,
      FORGEAX_TEST_COORDINATION: directory,
      FORGEAX_TEST_ROLE: index === 0 ? 'A' : 'B',
      ...extra,
    };
    if (target === undefined) delete env.CARGO_TARGET_DIR;
    else env.CARGO_TARGET_DIR = target;
    return execute(process.execPath, [join(roots[index], 'scripts/build-wasm.mjs')], {
      cwd: directory,
      env,
      timeout: 15_000,
    });
  };
  return { directory, roots, build };
}

for (const [name, sameSource, targetKind] of [
  ['different sources sharing an absolute cache', false, 'absolute'],
  ['identical sources building concurrently', true, 'absolute'],
  ['relative cache paths resolved from each package', false, 'relative'],
  ['default package-local cache', false, 'default'],
]) {
  test('build-wasm isolates ' + name, async (t) => {
    const { directory, roots, build } = await fixture(t, sameSource);
    const target =
      targetKind === 'absolute'
        ? join(directory, 'shared-target')
        : targetKind === 'relative'
          ? '../../../shared-target'
          : undefined;
    await Promise.all([build(0, target), build(1, target)]);
    const digests = [];
    for (const [index, root] of roots.entries()) {
      const receipt = await verifyProvenance({ root });
      const bytes = await readFile(join(root, 'pkg/ui_blitz_bg.wasm'));
      const sections = WebAssembly.Module.customSections(new WebAssembly.Module(bytes), 'test');
      assert.equal(
        Buffer.from(sections[0]).toString(),
        sameSource ? 'same source' : 'source ' + (index === 0 ? 'A' : 'B'),
      );
      const actual = JSON.parse(await readFile(join(root, 'compiler-target.json')));
      assert.equal(actual.target, join(resolve(root, target ?? 'target'), receipt.sourceDigest));
      assert.ok(actual.flags.split('\x1f').includes(`--remap-path-prefix=${resolve(root, '../..')}=/src/engine`));
      assert.ok(actual.flags.split('\x1f').includes(`--remap-path-prefix=${actual.target}=/build/target`));
      digests.push(receipt.sourceDigest);
    }
    assert.equal(digests[0] === digests[1], sameSource);
    const original = await resolveAsset(roots[0]);
    await writeFile(join(roots[0], 'scripts/build-wasm.mjs'), '// changed generation recipe');
    assert.notEqual((await resolveAsset(roots[0])).sha256, original.sha256);
  });
}

test('build-wasm rejects external overrides to its source-owned recipe', async (t) => {
  const { roots, build } = await fixture(t, true);
  for (const name of [
    'RUSTFLAGS',
    'CARGO_ENCODED_RUSTFLAGS',
    'CARGO_PROFILE_RELEASE_OPT_LEVEL',
    'RUSTC_WRAPPER',
  ]) {
    await assert.rejects(
      build(0, undefined, { FORGEAX_TEST_ROLE: 'solo', [name]: 'override' }),
      (error) => {
        assert.match(error.stderr, /Unsupported UI WASM build recipe overrides/);
        assert.ok(error.stderr.includes(name));
        return true;
      },
    );
  }
  await assert.rejects(readFile(join(roots[0], 'compiler-target.json')), { code: 'ENOENT' });
});
