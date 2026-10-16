import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAsset } from './content-key.mjs';

const owner = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(owner, 'package.json'));
const { build, version } = createRequire(require.resolve('tsup'))('esbuild');
const sourcePath = join(owner, 'pkg/basis_transcoder.mjs');
const source = await readFile(sourcePath, 'utf8');
const digest = (bytes) => ({
  bytes: Buffer.byteLength(bytes),
  sha256: createHash('sha256').update(bytes).digest('hex'),
});
const canonical = {
  glue: digest(source),
  wasm: digest(await readFile(join(owner, 'pkg/basis_transcoder.wasm'))),
};
let native = source;
// Specialize only generated environment admission. The complete Emscripten
// factory, imports, memory views, Embind registration and startup stay intact.
for (const [name, expression] of [
  ['ENVIRONMENT_IS_WEB', '!!globalThis.window'],
  ['ENVIRONMENT_IS_WORKER', '!!globalThis.WorkerGlobalScope'],
  [
    'ENVIRONMENT_IS_NODE',
    'globalThis.process?.versions?.node&&globalThis.process?.type!="renderer"',
  ],
]) {
  const declaration = `var ${name}=${expression};`;
  if (native.split(declaration).length !== 2)
    throw new Error(`Basis generated environment changed: requalify ${name}`);
  native = native.replace(declaration, '');
}
const result = await build({
  stdin: {
    contents: `import createModule from './basis_transcoder.mjs';
import { sha256 } from '@noble/hashes/sha2.js';
export const artifact = Object.freeze({
  glue: Object.freeze(${JSON.stringify(canonical.glue)}),
  wasm: Object.freeze(${JSON.stringify(canonical.wasm)}),
});
export default async function createNativeBasisModule(overrides) {
  if (typeof overrides?.instantiateWasm !== 'function' || typeof overrides?.readWasm !== 'function')
    throw new Error('Native Basis requires an explicit WASM Host before texture loading');
  const bytes = await overrides.readWasm();
  const digest = Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  if (bytes.byteLength !== artifact.wasm.bytes || digest !== artifact.wasm.sha256)
    throw new Error('Native Basis WASM differs from its published Emscripten glue');
  return createModule(overrides);
}`,
    resolveDir: join(owner, 'pkg'),
    sourcefile: 'basis-native-entry.mjs',
  },
  bundle: true,
  write: false,
  metafile: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: true,
  // Native packages have no browser module URL. The explicit Host owns the path.
  define: {
    'import.meta.url': '""',
    ENVIRONMENT_IS_WEB: 'false',
    ENVIRONMENT_IS_WORKER: 'false',
    ENVIRONMENT_IS_NODE: 'false',
  },
  plugins: [
    {
      name: 'basis-native-environment',
      setup(builder) {
        builder.onLoad({ filter: /basis_transcoder\.mjs$/ }, ({ path }) => {
          if (resolve(path) !== sourcePath) return;
          return { contents: native, loader: 'js', resolveDir: dirname(sourcePath) };
        });
      },
    },
  ],
});
if (Object.values(result.metafile.outputs).some((output) => output.imports.length > 0))
  throw new Error('Native Basis factory retained external environment imports');
const output = result.outputFiles[0].contents;
const provenance = {
  schema: 'forgeax-native-basis-factory/1',
  source: canonical.glue,
  wasm: canonical.wasm,
  javascript: digest(output),
  substrate: await resolveAsset(),
  producer: {
    path: 'scripts/build-native.mjs',
    ...digest(await readFile(fileURLToPath(import.meta.url))),
    esbuildVersion: version,
  },
};
await mkdir(join(owner, 'dist'), { recursive: true });
await writeFile(join(owner, 'dist/basis-native-factory.mjs'), output);
await writeFile(
  join(owner, 'dist/basis-native-factory.provenance.json'),
  `${JSON.stringify(provenance, null, 2)}\n`,
);
process.stdout.write(
  `Native Basis factory: ${output.length} bytes; unchanged WASM ${provenance.wasm.sha256}\n`,
);
