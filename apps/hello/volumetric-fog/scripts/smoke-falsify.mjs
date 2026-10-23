import { readFile } from 'node:fs/promises';

function usage() {
  console.error('usage: node scripts/smoke-falsify.mjs --receipt <path>');
  process.exitCode = 2;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function requireReceiptShape(value) {
  if (!isRecord(value)) throw new Error('receipt must be an object');
  for (const key of ['expectation', 'observed', 'verdict', 'confidence']) {
    if (!(key in value)) throw new Error(`receipt missing ${key}`);
  }
  if (!isRecord(value.expectation) || !isRecord(value.observed)) {
    throw new Error('expectation and observed must be objects');
  }
  if (typeof value.expectation.backend !== 'string') throw new Error('expectation.backend required');
  if (value.observed.backend !== value.expectation.backend) throw new Error('backend mismatch');
}

function requireProvenance(expectedProvenance, observedProvenance) {
  if (!isRecord(expectedProvenance) || !isRecord(observedProvenance)) {
    throw new Error('provenance is required');
  }
  for (const key of ['guid', 'digest']) {
    if (!isNonEmptyString(expectedProvenance[key])) {
      throw new Error(`expected provenance ${key} is required`);
    }
    if (!isNonEmptyString(observedProvenance[key])) {
      throw new Error(`observed provenance ${key} is required`);
    }
  }
  if (!Number.isInteger(expectedProvenance.generation)) {
    throw new Error('expected provenance generation must be an integer');
  }
  if (!Number.isInteger(observedProvenance.generation)) {
    throw new Error('observed provenance generation must be an integer');
  }
  for (const key of ['guid', 'generation', 'digest']) {
    if (observedProvenance[key] !== expectedProvenance[key]) {
      throw new Error(`provenance mismatch: ${key}`);
    }
  }
  if (!isNonEmptyString(observedProvenance.head)) {
    throw new Error('exact head is required');
  }
  const expectedHead = process.argv.indexOf('--head');
  if (expectedHead >= 0 && observedProvenance.head !== process.argv[expectedHead + 1]) {
    throw new Error('exact head mismatch');
  }
}

function requirePixel(expectation, observed) {
  if (!isRecord(expectation.pixel) || !isRecord(observed.pixel)) {
    throw new Error('pixel evidence is required');
  }
  const pixel = observed.pixel;
  for (const key of ['width', 'height', 'mean', 'variance', 'nonBackgroundRatio']) {
    if (typeof pixel[key] !== 'number' || !Number.isFinite(pixel[key])) {
      throw new Error(`observed pixel ${key} is required`);
    }
  }
  if (pixel.width < 2 || pixel.height < 2 || pixel.variance <= 0 || pixel.nonBackgroundRatio <= 0) {
    throw new Error('observed PNG has no discriminating pixels');
  }
}

function requireRendererVolume(volume, observedProvenance) {
  if (!isRecord(volume)) throw new Error('renderer volume inspection is required');
  if (!isNonEmptyString(volume.guid)) {
    throw new Error('renderer volume guid is required');
  }
  if (!isNonEmptyString(volume.digest)) {
    throw new Error('renderer volume digest is required');
  }
  if (!Number.isInteger(volume.generation)) {
    throw new Error('renderer volume generation must be an integer');
  }
  for (const key of ['guid', 'generation', 'digest']) {
    if (observedProvenance[key] !== volume[key]) {
      throw new Error(`renderer provenance mismatch: ${key}`);
    }
  }
  for (const key of ['status', 'resourceStage', 'passCount', 'sampleCount', 'memoryBytes']) {
    if (!(key in volume)) throw new Error(`renderer volume ${key} is required`);
  }
}

function requireBaselineTemporal(temporal) {
  if (!isRecord(temporal)) throw new Error('baseline renderer temporal inspection is required');
  if (temporal.mode === 'taa') {
    if (!isRecord(temporal.limits)) {
      throw new Error('baseline TAA renderer temporal limits are required');
    }
    if (
      typeof temporal.limits.maxTextureDimension3D !== 'number' ||
      !Number.isFinite(temporal.limits.maxTextureDimension3D)
    ) {
      throw new Error('baseline TAA renderer temporal maxTextureDimension3D is required');
    }
  } else if (temporal.mode !== 'fxaa' || temporal.status !== 'off') {
    throw new Error('baseline renderer temporal must be TAA or authored-off FXAA');
  }
}

function requireRendererTemporal(temporal, variant) {
  if (variant === 'baseline') {
    requireBaselineTemporal(temporal);
  } else if (temporal !== undefined && !isRecord(temporal)) {
    throw new Error('renderer temporal inspection must be an object');
  }
}

function requireRendererErrors(errors) {
  if (!Array.isArray(errors)) throw new Error('renderer error evidence is required');
  for (const error of errors) {
    if (
      !isRecord(error) ||
      typeof error.code !== 'string' ||
      typeof error.expected !== 'string' ||
      typeof error.hint !== 'string' ||
      !('detail' in error)
    ) {
      throw new Error('renderer errors must preserve code, expected, hint, and detail');
    }
  }
}

function requireRenderer(observed) {
  if (!isRecord(observed.renderer) || !Array.isArray(observed.renderer.volumePasses)) {
    throw new Error('renderer pass evidence is required');
  }
  const renderer = observed.renderer;
  if (renderer.backendKind !== observed.backend) {
    throw new Error('renderer backend authority mismatch');
  }
  requireRendererVolume(renderer.volumetricFog, observed.provenance);
  requireRendererTemporal(renderer.temporal, observed.variant);
  requireRendererErrors(renderer.errors);
  if (observed.variant === 'baseline' && renderer.volumePasses.length === 0) {
    throw new Error('baseline evidence has no volume passes');
  }
}

function requireDensityComparison(comparison) {
  if (!isRecord(comparison)) return;
  if (
    typeof comparison.changedPixels !== 'number' ||
    typeof comparison.meanRgbDelta !== 'number' ||
    comparison.changedPixels <= 0.01 ||
    comparison.meanRgbDelta <= 0.01
  ) {
    throw new Error('density comparison is not visually discriminating');
  }
}

function requireObservedVariants(variants) {
  if (!isRecord(variants)) return;
  const baseline = variants.baseline;
  const empty = variants['empty-density'];
  const disabled = variants['disable-volume'];
  if (!isRecord(baseline) || !isRecord(empty) || !isRecord(disabled)) {
    throw new Error('baseline, empty-density, and disable-volume evidence are required');
  }
  if (!Array.isArray(baseline.volumePasses) || baseline.volumePasses.length !== 4) {
    throw new Error('baseline must expose exactly four volume passes');
  }
  if (!Array.isArray(empty.volumePasses) || empty.volumePasses.length !== 4) {
    throw new Error('empty-density must expose exactly four volume passes');
  }
  if (!Array.isArray(disabled.volumePasses) || disabled.volumePasses.length !== 0) {
    throw new Error('disable-volume must expose zero volume passes');
  }
}

function requirePairedProducer(producer, variants) {
  if (!isRecord(producer)) return;
  const forgeax = producer.forgeax;
  const threejs = producer.threejs;
  if (!isRecord(forgeax) || !isRecord(threejs)) throw new Error('paired producer evidence is required');
  if (forgeax.producer === threejs.producer) throw new Error('self-comparison is not an independent oracle');
  for (const capture of [forgeax, threejs]) {
    if (capture.raw !== true || capture.synthetic === true || capture.skipped === true) {
      throw new Error('synthetic or skipped captures are unavailable');
    }
  }
  const requiredVariants = [
    'point-off', 'spot-off', 'projector-off', 'shadow-off', 'occluder-remove',
    'density-zero', 'camera-drift', 'time-drift', 'projector-hash-drift',
  ];
  if (!isRecord(variants)) throw new Error('causal variants are required');
  for (const variant of requiredVariants) {
    if (!isRecord(variants[variant]) || variants[variant].status !== 'pass') {
      throw new Error(`causal variant ${variant} is unavailable`);
    }
  }
}

function requireReceipt(value) {
  requireReceiptShape(value);
  requireProvenance(value.expectation.provenance, value.observed.provenance);
  requirePixel(value.expectation, value.observed);
  requireRenderer(value.observed);
  requireDensityComparison(value.observed.densityComparison);
  requireObservedVariants(value.observed.variants);
  if (value.verdict !== 'pass' || typeof value.confidence !== 'number' || value.confidence <= 0) {
    throw new Error('passing evidence requires positive confidence');
  }
  requirePairedProducer(value.producer, value.variants);
}

const receiptFlag = process.argv.indexOf('--receipt');
if (receiptFlag < 0 || process.argv[receiptFlag + 1] === undefined) {
  usage();
} else {
  try {
    const value = JSON.parse(await readFile(process.argv[receiptFlag + 1], 'utf8'));
    requireReceipt(value);
    console.log('FALSIFY PASS');
  } catch (error) {
    console.error(`FALSIFY FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
