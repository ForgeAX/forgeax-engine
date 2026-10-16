import {
  captureAutoExposureForgeax,
  type AutoExposureForgeaxArtifact,
  type AutoExposureForgeaxBundler,
} from './auto-exposure-forgeax-capture';

declare global {
  var __forgeaxAutoExposureForgeaxPublish:
    | ((path: string, output: AutoExposureForgeaxArtifact) => Promise<void> | void)
    | undefined;
}

function dispatchEnvironment(): Record<string, string | undefined> {
  const processEnvironment = typeof process === 'undefined' ? {} : process.env;
  return { ...import.meta.env, ...processEnvironment };
}

function positiveInteger(value: string | undefined, name: string, fallback?: number): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  if (parsed === undefined || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: `${name} must be a positive integer` }));
  }
  return parsed;
}

function exactRevision(value: string | undefined): string {
  if (value === undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'FORGEAX_AUTO_EXPOSURE_AC27_TESTED_REVISION must be the exact paired product revision' }));
  }
  return value;
}

function sha256(value: string | undefined, name: string): string {
  if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: `${name} must be a SHA-256 digest of the executed surface` }));
  }
  return value;
}

function runnerKind(value: string | undefined): 'browser-webgpu' | 'dawn' {
  if (value === 'browser-webgpu' || value === 'dawn') return value;
  throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'ForgeaX AC-27 backend must be browser-webgpu or dawn' }));
}

export function autoExposureForgeaxProducerIsScheduled(): boolean {
  const environment = dispatchEnvironment();
  return environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_SCHEDULED === '1'
    || environment.FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_SCHEDULED === '1';
}

export async function runAutoExposureForgeaxProducerEntry(forgeaxBundler: AutoExposureForgeaxBundler): Promise<void> {
  const environment = dispatchEnvironment();
  const backend = runnerKind(
    environment.FORGEAX_AUTO_EXPOSURE_AC27_BACKEND
      ?? environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_BACKEND,
  );
  const testedRevision = exactRevision(
    environment.FORGEAX_AUTO_EXPOSURE_AC27_TESTED_REVISION
      ?? environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_TESTED_REVISION,
  );
  const width = positiveInteger(
    environment.FORGEAX_AUTO_EXPOSURE_AC27_WIDTH
      ?? environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_WIDTH,
    'FORGEAX_AUTO_EXPOSURE_AC27_WIDTH',
    128,
  );
  const height = positiveInteger(
    environment.FORGEAX_AUTO_EXPOSURE_AC27_HEIGHT
      ?? environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_HEIGHT,
    'FORGEAX_AUTO_EXPOSURE_AC27_HEIGHT',
    128,
  );
  const build = sha256(
    environment.FORGEAX_AUTO_EXPOSURE_AC27_BUILD
      ?? environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_BUILD,
    'FORGEAX_AUTO_EXPOSURE_AC27_BUILD',
  );
  const sourceShaValue = environment.FORGEAX_AUTO_EXPOSURE_AC27_SOURCE_SHA
    ?? environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_SOURCE_SHA;
  const sourceSha = sourceShaValue === undefined ? undefined : sha256(sourceShaValue, 'FORGEAX_AUTO_EXPOSURE_AC27_SOURCE_SHA');
  const outputPath = environment.FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_OUTPUT
    ?? environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_OUTPUT
    ?? `auto-exposure-forgeax-${width}x${height}.json`;
  const runnerId = environment.FORGEAX_AUTO_EXPOSURE_AC27_RUNNER_ID
    ?? environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_RUNNER_ID
    ?? `${backend}-forgeax-ac27`;
  const lane = environment.FORGEAX_AUTO_EXPOSURE_AC27_REFERENCE_LANE
    ?? environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_REFERENCE_LANE
    ?? 'direct';
  if (lane !== 'direct' && lane !== 'clustered') {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'ForgeaX AC-27 reference lane must be direct or clustered' }));
  }
  const publish = globalThis.__forgeaxAutoExposureForgeaxPublish;
  if (publish === undefined) {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'ForgeaX AC-27 artifact publisher is unavailable' }));
  }
  const artifact = await captureAutoExposureForgeax({
    width,
    height,
    testedRevision,
    runner: { kind: backend, id: runnerId },
    referenceLane: lane,
    build,
    ...(sourceSha === undefined ? {} : { sourceSha }),
    forgeaxBundler,
  });
  await publish(outputPath, artifact);
}
