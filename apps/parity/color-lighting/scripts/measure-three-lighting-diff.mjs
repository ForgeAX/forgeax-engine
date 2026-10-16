#!/usr/bin/env node

// Measure already-captured ForgeaX/Three screenshots. This is deliberately a
// read-only diagnostic: it does not choose lighting parameters or mutate either
// renderer. The comparison is in display-space bytes, so it must not be read
// as a linear-HDR acceptance oracle.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { PNG } from 'pngjs';

const MODES = ['rect', 'ies', 'cookie', 'probe', 'spot-combined', 'recovery'];
const DEFAULT_Y_START = 100;
// The headed page keeps both canvases at the same aspect ratio, but the
// browser wrapper may capture CSS pixels or device pixels. These coordinates
// are the reference geometry from the 1150x818 capture and are scaled to the
// actual PNG, so the formula ROI remains stable across capture resolutions.
const PROBE_REFERENCE_SIZE = { width: 1150, height: 818 };
const PROBE_RECEIVER_CENTERS_X = [83, 207, 330, 452, 575, 700, 822, 945, 1067];
const PROBE_RECEIVER_CENTER_Y = 433;
const PROBE_RECEIVER_CORE_RADIUS = 40;

function usage() {
  console.error('Usage: node scripts/measure-three-lighting-diff.mjs --dir <screenshot-dir> [--prefix <name->] [--mode <rect|ies|cookie|probe|spot-combined|recovery>]');
  process.exitCode = 64;
}

function parseArgs(argv) {
  const options = { dir: null, prefix: '', modes: MODES };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dir') {
      options.dir = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === '--prefix') {
      options.prefix = argv[index + 1] ?? '';
      index += 1;
    } else if (argument === '--mode') {
      const mode = argv[index + 1] ?? '';
      if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);
      options.modes = [mode];
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      usage();
      return null;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.dir === null) throw new Error('--dir is required');
  return options;
}

function readPng(path) {
  return PNG.sync.read(readFileSync(path));
}

function isProbeReceiverCore(x, y, width, height) {
  const scaleX = width / PROBE_REFERENCE_SIZE.width;
  const scaleY = height / PROBE_REFERENCE_SIZE.height;
  const centerY = PROBE_RECEIVER_CENTER_Y * scaleY;
  const radius = PROBE_RECEIVER_CORE_RADIUS * Math.min(scaleX, scaleY);
  return PROBE_RECEIVER_CENTERS_X.some((centerX) =>
    (x - centerX * scaleX) ** 2 + (y - centerY) ** 2 <= radius ** 2,
  );
}

function measure(left, right, predicate) {
  let absolute = 0;
  let squared = 0;
  let maxChannelDelta = 0;
  let pixelsOver3 = 0;
  let pixelsOver10 = 0;
  let pixels = 0;
  for (let y = 0; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      if (!predicate(x, y)) continue;
      const index = (y * left.width + x) * 4;
      let pixelMax = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = Math.abs(left.data[index + channel] - right.data[index + channel]);
        absolute += delta;
        squared += delta * delta;
        maxChannelDelta = Math.max(maxChannelDelta, delta);
        pixelMax = Math.max(pixelMax, delta);
      }
      if (pixelMax > 3) pixelsOver3 += 1;
      if (pixelMax > 10) pixelsOver10 += 1;
      pixels += 1;
    }
  }
  if (pixels === 0) throw new Error('comparison ROI is empty');
  return {
    pixels,
    mae8: Number((absolute / (pixels * 3)).toFixed(6)),
    rmse8: Number(Math.sqrt(squared / (pixels * 3)).toFixed(6)),
    maxChannelDelta,
    pixelsOver3,
    pixelsOver10,
  };
}

function compareMode(dir, prefix, mode) {
  const forgeaxPath = resolve(dir, `${prefix}${mode}-forgeax.png`);
  const threePath = resolve(dir, `${prefix}${mode}-three.png`);
  const forgeax = readPng(forgeaxPath);
  const three = readPng(threePath);
  if (forgeax.width !== three.width || forgeax.height !== three.height) {
    throw new Error(`${mode}: size mismatch ${forgeax.width}x${forgeax.height} vs ${three.width}x${three.height}`);
  }

  const content = measure(forgeax, three, (_x, y) => y >= DEFAULT_Y_START);
  const result = {
    mode,
    images: {
      forgeax: forgeaxPath,
      three: threePath,
      size: `${forgeax.width}x${forgeax.height}`,
    },
    roi: {
      content: { yStart: DEFAULT_Y_START, ...content },
    },
  };

  if (mode === 'probe') {
    // The probe fixture has a stable [5,8,16] clear color. Report a fixed
    // center-core ROI separately from the full content ROI: the core keeps
    // SH/PBR arithmetic visible while the full ROI retains silhouette and
    // overlap differences instead of silently discarding them.
    result.roi.probeReceiverCore = measure(forgeax, three, (x, y) => isProbeReceiverCore(x, y, forgeax.width, forgeax.height));
    const backgroundX = Math.max(0, Math.round(10 * forgeax.width / PROBE_REFERENCE_SIZE.width));
    const backgroundY = Math.max(0, Math.round(120 * forgeax.height / PROBE_REFERENCE_SIZE.height));
    result.roi.probeBackgroundSample = {
      forgeax: [...forgeax.data.slice((backgroundY * forgeax.width + backgroundX) * 4, (backgroundY * forgeax.width + backgroundX) * 4 + 3)],
      three: [...three.data.slice((backgroundY * three.width + backgroundX) * 4, (backgroundY * three.width + backgroundX) * 4 + 3)],
    };
  }
  return result;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options === null) process.exit(0);
  console.log(JSON.stringify(options.modes.map((mode) => compareMode(options.dir, options.prefix, mode)), null, 2));
} catch (error) {
  console.error(`[measure-three-lighting-diff] ${error instanceof Error ? error.message : String(error)}`);
  usage();
}
