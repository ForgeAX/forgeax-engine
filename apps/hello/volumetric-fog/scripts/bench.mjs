import { execFileSync } from 'node:child_process';
import { resolveGpuTiming } from './bench-contract.mjs';

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const passNames = ['volume-inject', 'volume-integrate', 'volume-temporal', 'volume-composite'];
const cases = [
  { name: 'low', surfaceWidth: 1920, surfaceHeight: 1080, tileSize: 16, depth: 48, thresholdMs: 2 },
  { name: 'high', surfaceWidth: 1920, surfaceHeight: 1080, tileSize: 4, depth: 64, thresholdMs: 4 },
].map((profile) => ({
  ...profile,
  width: Math.ceil(profile.surfaceWidth / profile.tileSize),
  height: Math.ceil(profile.surfaceHeight / profile.tileSize),
}));

/**
 * The benchmark is a receipt consumer, not a second renderer. A qualified
 * runner supplies a receipt captured from Renderer.inspect() after its one
 * accepted RenderGraph submit. Node has no canvas/Renderer host, so it must
 * report the timing as unavailable instead of allocating a shadow pipeline.
 */
const unavailable = (profile) => {
  const timing = resolveGpuTiming({
    samples: [],
    timestampPeriodNs: null,
    qualified: false,
    thresholdMs: profile.thresholdMs,
  });
  return {
    profile: {
      name: profile.name,
      surfaceWidth: profile.surfaceWidth,
      surfaceHeight: profile.surfaceHeight,
      tileSize: profile.tileSize,
      depth: profile.depth,
      width: profile.width,
      height: profile.height,
    },
    topology: {
      passNames,
      passCount: passNames.length,
      integrated: true,
      logicalGrid: { width: profile.width, height: profile.height, depth: profile.depth },
      physicalGrid: { width: profile.width, height: profile.height, depth: profile.depth },
      sampleCount: profile.width * profile.height * profile.depth,
    },
    renderer: {
      source: 'engine-renderer-inspect',
      status: 'unavailable',
      reason: 'benchmark-requires-renderer-host-and-rhi-timestamp-submit',
    },
    resources: {
      status: 'unavailable',
      reason: 'descriptor-derived allocation requires an accepted Renderer receipt',
    },
    timing: {
      kind: 'gpu-timestamp',
      ...timing,
      reason: 'benchmark-requires-renderer-host-and-rhi-timestamp-submit',
    },
    samples: [],
    segments: {},
    p95Ms: null,
    qualified: false,
    pass: false,
    timestamp: new Date().toISOString(),
  };
};

const receipt = {
  schemaVersion: '4',
  head,
  runnerClass: 'local-node',
  source: 'engine-renderer-inspect',
  results: cases.map(unavailable),
};

console.log(JSON.stringify(receipt));
