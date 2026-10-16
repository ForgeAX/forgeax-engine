import {
  captureAutoExposureThreeR184,
  type AutoExposureThreeR184Artifact,
  type AutoExposureThreeR184CaptureOptions,
} from './auto-exposure-three-r184-capture';

declare global {
  var __forgeaxAutoExposureAc27Publish:
    | ((path: string, output: AutoExposureThreeR184Artifact) => Promise<void> | void)
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
    throw new Error(JSON.stringify({
      code: 'producer-entry-missing',
      detail: 'FORGEAX_AUTO_EXPOSURE_AC27_TESTED_REVISION must be the exact paired product revision',
    }));
  }
  return value;
}

function runnerKind(value: string | undefined): 'browser-webgpu' | 'dawn' {
  if (value === 'browser-webgpu' || value === 'dawn') return value;
  throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'Three r184 AC-27 backend must be browser-webgpu or dawn' }));
}

export function autoExposureAc27ProducerIsScheduled(): boolean {
  const environment = dispatchEnvironment();
  return environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_SCHEDULED === '1'
    || environment.FORGEAX_AUTO_EXPOSURE_AC27_SCHEDULED === '1';
}

export async function runAutoExposureThreeR184ProducerEntry(): Promise<void> {
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
  const outputPath = environment.FORGEAX_AUTO_EXPOSURE_AC27_OUTPUT
    ?? environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_OUTPUT
    ?? `auto-exposure-three-r184-${width}x${height}.json`;
  const runnerId = environment.FORGEAX_AUTO_EXPOSURE_AC27_RUNNER_ID
    ?? environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_RUNNER_ID
    ?? `${backend}-three-r184`;
  const lane = environment.FORGEAX_AUTO_EXPOSURE_AC27_REFERENCE_LANE
    ?? environment.VITE_FORGEAX_AUTO_EXPOSURE_AC27_REFERENCE_LANE
    ?? 'direct';
  if (lane !== 'direct' && lane !== 'clustered') {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'Three r184 AC-27 reference lane must be direct or clustered' }));
  }
  const publish = globalThis.__forgeaxAutoExposureAc27Publish;
  if (publish === undefined) {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'Three r184 AC-27 artifact publisher is unavailable' }));
  }
  const options: AutoExposureThreeR184CaptureOptions = {
    width,
    height,
    testedRevision,
    runner: { kind: backend, id: runnerId },
    referenceLane: lane,
  };
  const artifact = await captureAutoExposureThreeR184(options);
  await publish(outputPath, artifact);
}
