import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runBrowserCommand } from '../ci/run-browser-gate-with-retry.mjs';

export {
  decodeArtifactJsonText as decodeShaderManifestText,
  readArtifactJsonText as readShaderManifestText,
} from './artifact-json.mjs';

/** One owned URL transports the original plain/zstd bytes without expanding a data URL. */
export function openShaderManifestPublication(path) {
  const url = URL.createObjectURL(
    new Blob([readFileSync(path)], { type: 'application/octet-stream' }),
  );
  return { url, dispose: () => URL.revokeObjectURL(url) };
}

/** Short-lived native smoke processes own this publication until their bounded exit. */
export function processShaderManifestUrl(path) {
  const publication = openShaderManifestPublication(path);
  process.once('exit', publication.dispose);
  return publication.url;
}

/** Consumers own their optional profile; shard placement never implies readiness. */
export async function ensureShaderManifestProfile(
  profile,
  {
    sharedInputManifest = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST,
    run = runBrowserCommand,
  } = {},
) {
  const script = fileURLToPath(
    new URL('../forgeax/prepare-shader-release-inputs.mjs', import.meta.url),
  );
  const result = await run(
    [
      process.execPath,
      script,
      '--build',
      '--profile',
      profile,
      ...(sharedInputManifest ? ['--shared-input-manifest', sharedInputManifest] : []),
    ],
    { env: process.env, timeoutMs: 300_000, label: `Shader profile ${profile}`, gpuLease: false },
  );
  if (result.status !== 0)
    throw new Error(
      `Shader profile preparation failed: ${profile} (${result.signal ?? result.status})`,
    );
}
