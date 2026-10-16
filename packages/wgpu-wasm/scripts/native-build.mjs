// Build-time owner of the native-host binding. The canonical bundle is unchanged.
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArtifactProvenance } from './provenance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');

/** Derive a native binding from the exact publisher-provenanced WASM/glue pair. */
export async function buildNativeWgpu({ out, pkgDirectory = join(root, 'pkg') }) {
  const canonical = await verifyArtifactProvenance({ pkgDirectory });
  if (canonical.dependencies.wasmBindgen !== '0.2.129') {
    throw new Error('native wgpu binding requires the qualified wasm-bindgen 0.2.129 ABI');
  }
  const [glue, initializer, generator, declarations] = await Promise.all([
    readFile(join(pkgDirectory, 'wgpu_wasm.js'), 'utf8'),
    readFile(new URL('./native-init.js', import.meta.url), 'utf8'),
    readFile(fileURLToPath(import.meta.url)),
    readFile(join(pkgDirectory, 'wgpu_wasm.d.ts'), 'utf8'),
  ]);
  const loader = '\nasync function __wbg_load(module, imports) {';
  if (glue.split(loader).length !== 2 ||
      !glue.includes('function __wbg_finalize_init(instance, module) {') ||
      !glue.includes('"./wgpu_wasm_bg.js": import0')) {
    throw new Error('canonical wgpu glue shape changed; qualify the native binding generator');
  }
  // Keep every generated ABI wrapper and the finalizer. Replace only the browser
  // loader with an explicit native operation; no fetch, eval or global interception.
  const outputGlue = [
    "import { sha256 } from '@forgeax/engine/wgpu-wasm/native-host';",
    "const nativeSha256 = bytes => Array.from(sha256(bytes), v => v.toString(16).padStart(2, '0')).join('');",
    `const nativeArtifact = ${JSON.stringify({ bytes: canonical.artifactBytes, sha256: canonical.artifactSha256 })};`,
    glue.slice(0, glue.indexOf(loader)), initializer,
  ].join('\n');
  const declarationBoundary = '\nexport type InitInput =';
  if (declarations.split(declarationBoundary).length !== 2) {
    throw new Error('canonical wgpu declarations changed; qualify the native binding generator');
  }
  const outputDeclarations = [
    "import type { NativeWgpuInitializer } from '@forgeax/engine/wgpu-wasm/native-host';",
    declarations.slice(0, declarations.indexOf(declarationBoundary)),
    "export declare const initializeNativeWgpu: NativeWgpuInitializer['initializeNativeWgpu'];",
  ].join('\n');
  const receipt = {
    schemaVersion: 'wgpu-native-binding/1',
    canonical,
    generatorSha256: digest(generator),
    initializerSha256: digest(initializer),
    glueSha256: digest(outputGlue),
    glueBytes: Buffer.byteLength(outputGlue),
    canonicalDeclarationsSha256: digest(declarations),
    declarationsSha256: digest(outputDeclarations),
  };
  const directory = resolve(out);
  await mkdir(directory); // Never overwrite an existing module or project.
  await Promise.all([
    writeFile(join(directory, 'wgpu-native.mjs'), outputGlue),
    writeFile(join(directory, 'wgpu-native.d.mts'), outputDeclarations),
    copyFile(join(pkgDirectory, 'wgpu_wasm_bg.wasm'), join(directory, 'wgpu.wasm')),
    writeFile(join(directory, 'provenance.json'), `${JSON.stringify(receipt, null, 2)}\n`),
  ]);
  return { directory, receipt };
}
