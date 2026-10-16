import { readFile, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function usage() {
  console.error(
    'usage: node scripts/threejs-parity-evidence.mjs --manifest <json> --forgeax <png> --threejs <png> --forgeax-meta <json> --threejs-meta <json>',
  );
  process.exitCode = 2;
}

const REQUIRED_VARIANTS = [
  'point-off', 'spot-off', 'projector-off', 'shadow-off', 'occluder-remove',
  'density-zero', 'camera-drift', 'time-drift', 'projector-hash-drift',
];

async function readPng(path) {
  if (path === undefined) throw new Error('PNG path is required');
  const bytes = await readFile(path);
  return PNG.sync.read(bytes);
}

function luminance(image, x, y) {
  const index = (y * image.width + x) * 4;
  return (image.data[index] + image.data[index + 1] + image.data[index + 2]) / (3 * 255);
}

function metrics(image) {
  const marginX = Math.max(1, Math.floor(image.width * 0.1));
  const marginY = Math.max(1, Math.floor(image.height * 0.1));
  let sum = 0;
  let square = 0;
  let gradient = 0;
  let count = 0;
  let clipped = 0;
  for (let y = marginY; y < image.height - marginY; y += 1) {
    for (let x = marginX; x < image.width - marginX; x += 1) {
      const value = luminance(image, x, y);
      sum += value;
      square += value * value;
      count += 1;
      if (value >= 0.995) clipped += 1;
      if (x > marginX) gradient += Math.abs(value - luminance(image, x - 1, y));
    }
  }
  const mean = sum / count;
  return {
    width: image.width,
    height: image.height,
    roi: { left: marginX, top: marginY, right: image.width - marginX, bottom: image.height - marginY },
    mean,
    variance: Math.max(0, square / count - mean * mean),
    meanHorizontalGradient: gradient / count,
    clippingRatio: clipped / count,
  };
}

function pixelDelta(left, right) {
  if (left.width !== right.width || left.height !== right.height) throw new Error('paired raw PNGs must share dimensions');
  let changed = 0;
  let total = 0;
  const count = left.width * left.height;
  for (let index = 0; index < left.data.length; index += 4) {
    const delta = (Math.abs(left.data[index] - right.data[index]) + Math.abs(left.data[index + 1] - right.data[index + 1]) + Math.abs(left.data[index + 2] - right.data[index + 2])) / (3 * 255);
    if (delta > 0.01) changed += 1;
    total += delta;
  }
  return { changedPixels: changed / count, meanRgbDelta: total / count };
}

async function readJson(path, label) {
  if (path === undefined) throw new Error(`${label} metadata is required`);
  return JSON.parse(await readFile(path, 'utf8'));
}

function requireCaptureIdentity(capture, label, manifest) {
  if (capture?.producer !== label) throw new Error(`${label} capture producer identity is required`);
  for (const key of ['head', 'backend', 'adapter', 'compositor', 'colorSpace']) {
    if (typeof capture[key] !== 'string' || capture[key].length === 0) throw new Error(`${label} capture ${key} identity is required`);
  }
  if (capture.backend !== manifest.evidence.requiredBackend) throw new Error(`${label} capture must use headed-webgpu`);
  for (const key of ['dpr', 'cssWidth', 'cssHeight', 'frozenTime', 'settleFrames', 'normalizedFrame', 'internalFrame', 'history']) {
    if (!(key in capture)) throw new Error(`${label} capture ${key} identity is required`);
  }
  if (!Number.isInteger(capture.normalizedFrame) || capture.normalizedFrame < 0) {
    throw new Error(`${label} capture normalizedFrame must be a non-negative integer`);
  }
  if (!Number.isInteger(capture.internalFrame) || capture.internalFrame < 0) {
    throw new Error(`${label} capture internalFrame must be a non-negative integer`);
  }
  if (capture.cssWidth !== manifest.evidence.width || capture.cssHeight !== manifest.evidence.height) throw new Error(`${label} capture CSS size does not match the manifest`);
  if (capture.raw !== true || capture.synthetic === true || capture.skipped === true) throw new Error(`${label} capture must be raw, non-synthetic, and non-skipped`);
}

async function runPairedEvidence() {
  const manifestPath = option('--manifest');
  const forgeaxPath = option('--forgeax');
  const threePath = option('--threejs');
  const output = option('--output');
  try {
    if (manifestPath === undefined || forgeaxPath === undefined || threePath === undefined) throw new Error('manifest, ForgeaX raw PNG, and Three.js raw PNG are required');
    const manifest = await readJson(manifestPath, 'manifest');
    if (manifest.oracle?.commit !== 'ad005397bbd15b0a9fcd5159c782eba56e1cba2a') throw new Error('pinned Three.js oracle commit is required');
    if (manifest.evidence?.requiredBackend !== 'headed-webgpu' || manifest.evidence?.pairedRawPng !== true) throw new Error('manifest must require headed raw WebGPU evidence');
    const [forgeax, threejs, forgeaxMeta, threeMeta] = await Promise.all([readPng(forgeaxPath), readPng(threePath), readJson(option('--forgeax-meta'), 'ForgeaX'), readJson(option('--threejs-meta'), 'Three.js')]);
    requireCaptureIdentity(forgeaxMeta, 'forgeax', manifest);
    requireCaptureIdentity(threeMeta, 'threejs', manifest);
    for (const key of ['adapter', 'compositor', 'dpr', 'cssWidth', 'cssHeight', 'colorSpace', 'frozenTime', 'settleFrames', 'normalizedFrame', 'history']) {
      if (forgeaxMeta[key] !== threeMeta[key]) throw new Error(`paired capture identity mismatch: ${key}`);
    }
    if (forgeax.width !== manifest.evidence.width || forgeax.height !== manifest.evidence.height) throw new Error('ForgeaX raw PNG dimensions do not match the manifest');
    if (threejs.width !== manifest.evidence.width || threejs.height !== manifest.evidence.height) throw new Error('Three.js raw PNG dimensions do not match the manifest');
    const forgeaxVariantDir = option('--forgeax-variant-dir');
    const threejsVariantDir = option('--threejs-variant-dir');
    const variants = Object.fromEntries(
      REQUIRED_VARIANTS.map((variant) => [variant, { status: 'unavailable', expectation: `requires ${variant} causal receipt` }]),
    );
    if ((forgeaxVariantDir === undefined) !== (threejsVariantDir === undefined)) {
      throw new Error('both producer variant directories are required');
    }
    if (forgeaxVariantDir !== undefined && threejsVariantDir !== undefined) {
      for (const variant of REQUIRED_VARIANTS) {
        try {
          const [forgeaxVariant, threejsVariant] = await Promise.all([
            readPng(`${forgeaxVariantDir}/${variant}.png`),
            readPng(`${threejsVariantDir}/${variant}.png`),
          ]);
          const causalDelta = {
            forgeax: pixelDelta(forgeax, forgeaxVariant),
            threejs: pixelDelta(threejs, threejsVariant),
          };
          const status =
            causalDelta.forgeax.changedPixels > 0.01 &&
            causalDelta.forgeax.meanRgbDelta > 0.01 &&
            causalDelta.threejs.changedPixels > 0.01 &&
            causalDelta.threejs.meanRgbDelta > 0.01
              ? 'pass'
              : 'fail';
          variants[variant] = {
            status,
            expectation: `baseline-to-${variant} must change both producer images`,
            causalDelta,
          };
        } catch (error) {
          variants[variant] = {
            status: 'unavailable',
            expectation: `requires ${variant} causal receipt`,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }
    const causalReady = REQUIRED_VARIANTS.every((variant) => variants[variant].status === 'pass');
    const fullFrame = pixelDelta(forgeax, threejs);
    const visualReady = fullFrame.meanRgbDelta <= 0.05;
    const receipt = {
      schemaVersion: '1',
      manifest: { path: manifestPath, scene: manifest.scene, oracleCommit: manifest.oracle.commit },
      producer: { forgeax: forgeaxMeta, threejs: threeMeta },
      backend: manifest.evidence.requiredBackend,
      captures: { forgeax: { width: forgeax.width, height: forgeax.height, raw: forgeaxMeta.raw }, threejs: { width: threejs.width, height: threejs.height, raw: threeMeta.raw } },
      comparison: { fullFrame, roi: { status: 'unavailable', reason: 'named ROI capture is required' } },
      variants,
      expectation: { oracle: 'pinned-threejs-webgpu-volume-lighting', requiredVariants: REQUIRED_VARIANTS },
      observed: { forgeax: metrics(forgeax), threejs: metrics(threejs) },
      verdict: causalReady && visualReady ? 'pass' : 'unavailable',
      confidence: causalReady && visualReady ? 0.8 : 0,
      reason: causalReady
        ? visualReady
          ? 'paired raw images and causal variant receipts passed'
          : `paired causal receipts passed but full-frame meanRgbDelta=${fullFrame.meanRgbDelta.toFixed(4)} exceeds the 0.05 visual tolerance`
        : 'causal variant receipts are required before a paired parity pass can be claimed',
    };
    if (output !== undefined) await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt));
  } catch (error) {
    const receipt = { schemaVersion: '1', verdict: 'unavailable', confidence: 0, reason: error instanceof Error ? error.message : String(error) };
    if (output !== undefined) await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
    console.error(`PARITY EVIDENCE UNAVAILABLE: ${receipt.reason}`);
    process.exitCode = 1;
  }
}

const forgeaxPath = option('--forgeax');
const manifestPath = option('--manifest');
if (manifestPath !== undefined) {
  await runPairedEvidence();
} else {
const godraysPath = option('--godrays');
const volumeLightingPath = option('--volume-lighting');
if (forgeaxPath === undefined || godraysPath === undefined || volumeLightingPath === undefined) {
  usage();
} else {
  try {
    const [forgeax, godrays, volumeLighting] = await Promise.all([
      readPng(forgeaxPath),
      readPng(godraysPath),
      readPng(volumeLightingPath),
    ]);
    const images = { forgeax, godrays, volumeLighting };
    const dimensions = new Set(Object.values(images).map((image) => `${image.width}x${image.height}`));
    if (dimensions.size !== 1) throw new Error('comparison PNGs must share dimensions');
    const evidence = {
      schemaVersion: '1',
      source: 'observed-png',
      comparison: {
        forgeax: metrics(forgeax),
        threejsGodrays: metrics(godrays),
        threejsVolumeLighting: metrics(volumeLighting),
      },
      interpretation: {
        godrays: 'screen-space reference; image metrics do not prove volumetric causality',
        volumeLighting: '3D volume reference; compare visible depth and light transport manually',
        forgeax: 'renderer image only; pair with renderer.inspect and falsifier receipts',
      },
    };
    const output = option('--output');
    if (output !== undefined) await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence));
  } catch (error) {
    console.error(`PARITY EVIDENCE UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
}
