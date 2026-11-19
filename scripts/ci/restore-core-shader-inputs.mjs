import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareBrowserGlueAsset } from '../../packages/wgpu-wasm/scripts/prepare-browser-glue.mjs';
import { verifyProvenance } from '../../packages/wgpu-wasm/scripts/provenance.mjs';
import {
  projectSharedShader,
  reusableSharedShader,
  sharedShaderInputFingerprint,
} from '../lib/shared-build-cache.mjs';

export const coreBaseShaderDirectory =
  'packages/vite-plugin-shader/dist/engine-inputs/ci/base-ssao';

function assertCoreSource(root, extracted, { sourceRevision } = {}) {
  if (sourceRevision !== undefined && !/^[a-f0-9]{40}$/.test(sourceRevision))
    throw new Error('core shader inputs require an exact source revision');
  // A verifier-owned projection has no Git metadata. Its parent supplies the
  // original revision; the rebuilt compiler and authored source still bind the
  // profile below. Existing checkouts always retain their own HEAD authority.
  const checkoutSha =
    sourceRevision === undefined || existsSync(join(root, '.git'))
      ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      : sourceRevision;
  if (sourceRevision !== undefined && sourceRevision !== checkoutSha)
    throw new Error('core shader source revision differs from checkout HEAD');
  const expectedSha = checkoutSha;
  // The prepared checkout retains its real HEAD; an artifact extraction retains
  // the producer's original source receipt. Never manufacture an artifact receipt
  // for a checkout or change either identity while projecting its BASE payload.
  const inputCheckoutSha = existsSync(join(extracted, '.git'))
    ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extracted, encoding: 'utf8' }).trim()
    : undefined;
  const identityPath = join(extracted, 'engine-prerequisite-build-manifest.json');
  const inputSha = existsSync(identityPath)
    ? JSON.parse(readFileSync(identityPath, 'utf8')).engineSha
    : inputCheckoutSha;
  if (inputCheckoutSha !== undefined && inputCheckoutSha !== inputSha)
    throw new Error('core artifact source revision differs from input checkout HEAD');
  if (inputSha !== expectedSha) throw new Error('core payload source SHA mismatch');
}

/** Native source equality does not imply independently rebuilt bundle-byte equality. */
export async function restoreCoreCompiler(root, extracted, options) {
  assertCoreSource(root, extracted, options);
  const source = join(extracted, 'packages/wgpu-wasm/pkg');
  await verifyProvenance({ pkgDirectory: source });
  const target = join(root, 'packages/wgpu-wasm/pkg');
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  await prepareBrowserGlueAsset(
    join(target, 'wgpu_wasm.js'),
    join(root, 'packages/wgpu-wasm/dist/wgpu_wasm_glue.bytes'),
  );
}

export function restoreCoreBaseShader(root, extracted, options) {
  assertCoreSource(root, extracted, options);
  const fingerprint = sharedShaderInputFingerprint(root, { pointShadows: false, hdrpSsao: true });
  // Core, shared transfer and paired View builds retain independent BASE
  // receipts in their producer locations. POINT cannot satisfy admission.
  let admitted;
  const reasons = [];
  for (const directory of [
    coreBaseShaderDirectory,
    'shared-app-inputs/profiles/base-ssao',
    'shared-build-inputs-release/base-ssao',
  ]) {
    const manifest = join(extracted, directory, 'manifest.json');
    if (reusableSharedShader(extracted, manifest, fingerprint, (reason) => reasons.push(reason))) {
      admitted = directory;
      break;
    }
  }
  if (admitted === undefined)
    throw new Error(`core base shader admission failed: ${reasons.join('; ')}`);
  // Keep the original root-relative receipt while crossing source roots, then
  // use the maintained projection owner to bind the canonical BASE destination.
  const staged = join(root, admitted);
  if (resolve(root) !== resolve(extracted)) {
    mkdirSync(staged, { recursive: true });
    cpSync(join(extracted, admitted), staged, { recursive: true });
  }
  const target = join(root, coreBaseShaderDirectory);
  if (admitted !== coreBaseShaderDirectory)
    projectSharedShader(root, join(staged, 'manifest.json'), target, fingerprint);
  if (!reusableSharedShader(root, join(target, 'manifest.json'), fingerprint))
    throw new Error('restored core base shader receipt failed verification');
}

async function main() {
  const index = process.argv.indexOf('--artifact-id');
  const artifactId = process.argv[index + 1];
  if (index < 0 || !/^[1-9]\d*$/.test(artifactId ?? ''))
    throw new Error('exact core artifact ID required');
  const root = process.cwd();
  const staging = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'forgeax-core-base-'));
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync(
      process.execPath,
      [
        'scripts/ci/download-artifact-with-retry.mjs',
        '--artifact-ids',
        artifactId,
        '--path',
        staging,
      ],
      { stdio: 'inherit', env: { ...process.env, FORGEAX_ARTIFACT_EXPECTED_SHA: sha } },
    );
    if (process.argv.includes('--prepare-compiler')) {
      await restoreCoreCompiler(root, staging);
      execFileSync(
        process.execPath,
        [
          'scripts/build-packages.mjs',
          '--target=@forgeax/engine-runtime',
          '--target=@forgeax/engine-vite-plugin-shader',
          '--target=@forgeax/engine-rhi-wgpu',
        ],
        { cwd: root, stdio: 'inherit' },
      );
    }
    restoreCoreBaseShader(root, staging);
    console.log(`[core-shader-inputs] restored verified base artifact=${artifactId} source=${sha}`);
  } finally {
    rmSync(resolve(staging), { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
