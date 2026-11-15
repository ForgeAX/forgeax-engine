import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reusableSharedShader, sharedShaderInputFingerprint } from '../lib/shared-build-cache.mjs';

export const coreBaseShaderDirectory =
  'packages/vite-plugin-shader/dist/engine-inputs/ci/base-ssao';

export function restoreCoreBaseShader(root, extracted, { sourceRevision } = {}) {
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
  const fingerprint = sharedShaderInputFingerprint(root, { pointShadows: false, hdrpSsao: true });
  // Verify in the extraction root so the producer's root-relative digest and
  // payload path remain unchanged. Copy only the existing base profile.
  const manifest = join(extracted, coreBaseShaderDirectory, 'manifest.json');
  let reason;
  if (
    !reusableSharedShader(extracted, manifest, fingerprint, (value) => {
      reason = value;
    })
  )
    throw new Error(`core base shader admission failed: ${reason}`);
  const target = join(root, coreBaseShaderDirectory);
  mkdirSync(target, { recursive: true });
  cpSync(join(extracted, coreBaseShaderDirectory), target, { recursive: true });
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
    restoreCoreBaseShader(root, staging);
    console.log(`[core-shader-inputs] restored verified base artifact=${artifactId} source=${sha}`);
  } finally {
    rmSync(resolve(staging), { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
