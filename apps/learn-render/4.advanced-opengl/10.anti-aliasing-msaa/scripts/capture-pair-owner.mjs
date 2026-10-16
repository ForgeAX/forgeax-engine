import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { decodeTape } from '@forgeax/engine-rhi-debug';

const LINEAGE_LIMIT = 64;
const IDENTITY_FIELDS = [
  'pairedCaptureLineage',
  'workload',
  'logicalFrame',
  'captureEnvironment',
  'evidenceScope',
  'outputShape',
];

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function same(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function rejected(field, observed) {
  return {
    schemaVersion: '1.0',
    status: 'rejected',
    failure: {
      code: 'paired-identity-mismatch',
      expected: `${field} must match the explicit paired identity`,
      hint: `select or recapture a comparison artifact with ${field}=${JSON.stringify(observed)}`,
      detail: { field, expected: 'baseline value', observed },
    },
  };
}

function invalid(field, reason) {
  return {
    schemaVersion: '1.0',
    status: 'rejected',
    failure: {
      code: 'paired-input-invalid',
      expected: 'two complete final-color-rgb8 capture artifacts',
      hint: `provide ${field} and retry the capture comparison`,
      detail: { field, reason, recoveryAction: `recapture ${field}` },
    },
  };
}

function firstHandle(event, eventIndex) {
  if (!isObject(event)) return `event:${eventIndex}`;
  for (const key of [
    'handleId',
    'resultHandleId',
    'passHandleId',
    'pipelineHandleId',
    'bindGroupHandleId',
    'bufferHandleId',
    'textureHandleId',
    'viewHandleId',
    'sourceHandleId',
    'encoderHandleId',
    'commandBufferHandleId',
  ]) {
    if (typeof event[key] === 'string' && event[key].length > 0) return event[key];
  }
  for (const key of ['colorAttachmentViewHandleIds', 'colorAttachmentResolveTargetHandleIds']) {
    if (Array.isArray(event[key])) {
      const handle = event[key].find((value) => typeof value === 'string' && value.length > 0);
      if (handle !== undefined) return handle;
    }
  }
  return `event:${eventIndex}`;
}

function accessFor(event, eventIndex) {
  const resourceHandleId = firstHandle(event, eventIndex);
  const kind = typeof event?.kind === 'string' ? event.kind : 'unknown';
  return {
    eventIndex,
    accessOrdinal: 0,
    eventKind: kind,
    direction: kind.startsWith('create') || kind.startsWith('write') ? 'write' : 'read',
    role: kind.includes('RenderPass') ? 'attachment' : 'binding',
    resourceKind: kind.includes('Texture') || kind.includes('RenderPass') ? 'texture' : 'buffer',
    resourceHandleId,
    subresource: { mipLevel: 0, aspect: 'all' },
    validity: 'valid',
  };
}

function comparableIndexes(baselineEvents, comparisonEvents) {
  const indexes = [];
  const length = Math.max(baselineEvents.length, comparisonEvents.length);
  for (let index = 0; index < length; index += 1) {
    const baseline = baselineEvents[index];
    const comparison = comparisonEvents[index];
    if (firstHandle(baseline, index).startsWith('event:') && firstHandle(comparison, index).startsWith('event:')) {
      continue;
    }
    indexes.push(index);
  }
  return indexes;
}

function eventResource(baselineEvents, comparisonEvents) {
  const indexes = comparableIndexes(baselineEvents, comparisonEvents);
  const edges = indexes.slice(0, LINEAGE_LIMIT).map((eventIndex) => ({
    accessIndex: eventIndex,
    baseline:
      baselineEvents[eventIndex] === undefined ? null : accessFor(baselineEvents[eventIndex], eventIndex),
    comparison:
      comparisonEvents[eventIndex] === undefined
        ? null
        : accessFor(comparisonEvents[eventIndex], eventIndex),
  }));
  const first = indexes.find((eventIndex) => !same(baselineEvents[eventIndex], comparisonEvents[eventIndex]));
  if (first === undefined) {
    return {
      status: 'no-divergence',
      firstDivergence: null,
      lineage: {
        limit: LINEAGE_LIMIT,
        returned: edges.length,
        total: indexes.length,
        completeness: indexes.length > LINEAGE_LIMIT ? 'truncated' : 'complete',
        edges,
      },
    };
  }
  const baseline = baselineEvents[first];
  const comparison = comparisonEvents[first];
  return {
    status: 'divergence',
    firstDivergence: {
      accessIndex: first,
      field: 'event.payload',
      baseline: accessFor(baseline, first),
      comparison: accessFor(comparison, first),
    },
    lineage: {
      limit: LINEAGE_LIMIT,
      returned: edges.length,
      total: indexes.length,
      completeness: indexes.length > LINEAGE_LIMIT ? 'truncated' : 'complete',
      edges,
    },
  };
}

function rawComparison(baselineBytes, comparisonBytes, shape) {
  const first = { value: null };
  const last = { value: null };
  let changedPixelCount = 0;
  let totalDelta = 0;
  let maximumChannelDelta = 0;
  const pixelCount = shape.width * shape.height;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    let changed = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const offset = pixel * 4 + channel;
      const baseline = baselineBytes[offset];
      const comparison = comparisonBytes[offset];
      const delta = Math.abs(comparison - baseline);
      totalDelta += delta / 255;
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      if (delta !== 0) {
        changed = true;
        const divergence = {
          coordinate: {
            x: pixel % shape.width,
            y: Math.floor(pixel / shape.width),
            channel: ['r', 'g', 'b'][channel],
          },
          baseline,
          comparison,
        };
        first.value ??= divergence;
        last.value = divergence;
      }
    }
    if (changed) changedPixelCount += 1;
  }
  return {
    raw: {
      domain: 'final-color-rgb8',
      order: 'y-then-x-then-rgb-channel',
      baselineBytes,
      comparisonBytes,
    },
    first: first.value,
    last: last.value,
    metrics: {
      status: 'available',
      changedPixelCount,
      changedPixelFraction: pixelCount === 0 ? 0 : changedPixelCount / pixelCount,
      meanRgbDelta: pixelCount === 0 ? 0 : totalDelta / (pixelCount * 3),
      maximumChannelDelta,
      basis: {
        domain: 'final-color-rgb8',
        channelTolerance: 0,
        normalization: 'rgb-channel-delta-divided-by-255',
      },
    },
  };
}

function changedControl(baseline, comparison) {
  const names = new Set([...Object.keys(baseline), ...Object.keys(comparison)]);
  const changed = [...names].filter((name) => !same(baseline[name], comparison[name]));
  if (changed.length !== 1) return null;
  const name = changed[0];
  return { name, baseline: baseline[name], comparison: comparison[name] };
}

function loadManifest(manifestPath) {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`failed to read capture pair manifest '${manifestPath}': ${error.message}`);
  }
}

function loadTape(manifestPath, artifact, side) {
  if (isObject(artifact?.tape)) return artifact.tape;
  if (typeof artifact?.tapePath !== 'string' || artifact.tapePath.length === 0) {
    return undefined;
  }
  const tapePath = resolve(dirname(manifestPath), artifact.tapePath);
  let bytes;
  try {
    bytes = new Uint8Array(readFileSync(tapePath));
  } catch (error) {
    throw new Error(`failed to read ${side} capture tape '${tapePath}': ${error.message}`);
  }
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (artifact.tapeDigest !== digest) {
    throw new Error(
      `failed to verify ${side} capture tape digest: expected ${artifact.tapeDigest}, computed ${digest}`,
    );
  }
  const decoded = decodeTape(bytes);
  if (!decoded.ok) throw new Error(`failed to decode ${side} capture tape: ${decoded.error.code}`);
  return decoded.value;
}

export function compareCapturePair(manifestPath) {
  const manifest = loadManifest(manifestPath);
  const baseline = manifest?.baseline;
  const comparison = manifest?.comparison;
  if (!isObject(baseline) || !isObject(comparison)) return invalid('baseline/comparison', 'both artifacts are required');

  for (const field of IDENTITY_FIELDS) {
    if (!same(baseline[field], comparison[field])) return rejected(field, comparison[field]);
  }
  const control = changedControl(baseline.controls, comparison.controls);
  if (control === null) return invalid('controls', 'exactly one control must change');
  const shape = baseline.outputShape;
  if (!isObject(shape) || shape.channels !== 4 || !Number.isSafeInteger(shape.width) || !Number.isSafeInteger(shape.height)) {
    return invalid('outputShape', 'width, height, and four channels are required');
  }
  const expectedBytes = shape.width * shape.height * 4;
  const baselineBytes = baseline.finalColorRgb8;
  const comparisonBytes = comparison.finalColorRgb8;
  if (
    !Array.isArray(baselineBytes) ||
    !Array.isArray(comparisonBytes) ||
    baselineBytes.length !== expectedBytes ||
    comparisonBytes.length !== expectedBytes
  ) {
    return invalid('finalColorRgb8', `expected ${expectedBytes} bytes per artifact`);
  }
  const baselineTape = loadTape(manifestPath, baseline, 'baseline');
  const comparisonTape = loadTape(manifestPath, comparison, 'comparison');
  if (!baselineTape || !comparisonTape) return invalid('tapePath', 'both capture tapes are required');
  const baselineEvents = [
    ...baselineTape.bootstrap.map((resource) => resource.create),
    ...baselineTape.events,
  ];
  const comparisonEvents = [
    ...comparisonTape.bootstrap.map((resource) => resource.create),
    ...comparisonTape.events,
  ];
  const events = eventResource(baselineEvents, comparisonEvents);
  const pixels = rawComparison(baselineBytes, comparisonBytes, shape);
  return {
    schemaVersion: '1.0',
    status: 'accepted',
    pair: {
      baseline: { artifactId: baseline.artifactId, controls: baseline.controls },
      comparison: { artifactId: comparison.artifactId, controls: comparison.controls },
      pairedCaptureLineage: baseline.pairedCaptureLineage,
      workload: baseline.workload,
      logicalFrame: baseline.logicalFrame,
      captureEnvironment: baseline.captureEnvironment,
      evidenceScope: baseline.evidenceScope,
      outputShape: shape,
      changedControl: control,
    },
    eventResource: events,
    rawComparison: pixels.raw,
    rawFirstDivergence: pixels.first,
    rawLastDivergence: pixels.last,
    derivedMetrics: pixels.metrics,
    outcome: pixels.first === null ? 'no-divergence' : 'divergence',
  };
}
