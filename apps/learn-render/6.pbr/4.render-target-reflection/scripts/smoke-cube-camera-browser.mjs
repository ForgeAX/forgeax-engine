#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CUBE_CAMERA_FACE_ORDER } from '@forgeax/engine-render';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '../../../../..');
const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const reflectionEvidence = process.env.VITE_REFLECTION_PROBE_EVIDENCE === '1';
const faceColor = (face) => {
  switch (face) {
    case '+X': return [1, 0, 0];
    case '-X': return [0, 1, 1];
    case '+Y': return [0, 1, 0];
    case '-Y': return [1, 0, 1];
    case '+Z': return [0, 0, 1];
    case '-Z': return [1, 1, 0];
  }
};
const FACE_COLORS = CUBE_CAMERA_FACE_ORDER.map(faceColor);
const nearestCubeFaceIndex = (pixel) => {
  let bestIndex = -1;
  let bestDistance = Infinity;
  for (const [index, expected] of FACE_COLORS.entries()) {
    const distance = Math.max(
      ...expected.map((value, channel) => Math.abs(value * 255 - pixel[channel])),
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return { index: bestIndex, distance: bestDistance };
};
const nearestCubeFaceEpsilon = (pixel) => Math.min(
  ...FACE_COLORS.map((expected) => Math.max(
    ...expected.map((value, channel) => Math.abs(value - pixel[channel])),
  )),
);
const findMaterialSamplingPixel = (pixels, width, height) => {
  let best;
  let bestScore = -Infinity;
  for (let y = Math.floor(height * 0.3); y < Math.ceil(height * 0.7); y += 4) {
    for (let x = Math.floor(width * 0.3); x < Math.ceil(width * 0.7); x += 4) {
      const offset = (y * width + x) * 4;
      const pixel = [
        (pixels[offset] ?? 0) / 255,
        (pixels[offset + 1] ?? 0) / 255,
        (pixels[offset + 2] ?? 0) / 255,
        (pixels[offset + 3] ?? 0) / 255,
      ];
      const epsilon = nearestCubeFaceEpsilon(pixel);
      const saturation = Math.max(pixel[0], pixel[1], pixel[2]) - Math.min(pixel[0], pixel[1], pixel[2]);
      if (epsilon <= 0.2 && saturation >= 0.2 && saturation - epsilon > bestScore) {
        best = pixel;
        bestScore = saturation - epsilon;
      }
    }
  }
  return best;
};
const countLowerYellowReflectionPixels = (pixels, width, height) => {
  let count = 0;
  const minX = Math.floor(width * 0.38);
  const maxX = Math.ceil(width * 0.52);
  const minY = Math.floor(height * 0.54);
  const maxY = Math.ceil(height * 0.63);
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      if (red > 180 && green > 110 && green < 250 && blue < 110 && red > green * 0.85) {
        count += 1;
      }
    }
  }
  return count;
};
const countSemanticReflectionPixels = (pixels, width, height) => {
  const counts = Array.from({ length: FACE_COLORS.length }, () => 0);
  for (let y = Math.floor(height * 0.25); y < Math.ceil(height * 0.75); y += 1) {
    for (let x = Math.floor(width * 0.25); x < Math.ceil(width * 0.75); x += 1) {
      const offset = (y * width + x) * 4;
      const pixel = [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0];
      const nearest = nearestCubeFaceIndex(pixel);
      if (nearest.distance <= 13) counts[nearest.index] += 1;
    }
  }
  return counts;
};
const countWhiteMarkerReflectionPixels = (pixels, width, height) => {
  let count = 0;
  for (let y = Math.floor(height * 0.25); y < Math.ceil(height * 0.55); y += 1) {
    for (let x = Math.floor(width * 0.25); x < Math.ceil(width * 0.75); x += 1) {
      const offset = (y * width + x) * 4;
      if (
        (pixels[offset] ?? 0) > 220 &&
        (pixels[offset + 1] ?? 0) > 220 &&
        (pixels[offset + 2] ?? 0) > 220
      ) count += 1;
    }
  }
  return count;
};
process.env.VITE_FORGEAX_SOURCE_SHA = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: dirname(here),
  encoding: 'utf8',
}).trim();
process.env.VITE_FORGEAX_SSR_SOURCE_TREE = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
  cwd: rootDir,
  encoding: 'utf8',
}).trim();
process.env.VITE_FORGEAX_SSR_LOCK_SHA256 = hashFile(resolve(rootDir, 'pnpm-lock.yaml'));
process.env.VITE_FORGEAX_SSR_BUILD_SHA256 = hashFile(resolve(rootDir, 'packages/render/dist/index.mjs'));

const verification = await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-6-pbr-4-render-target-reflection',
  label: reflectionEvidence
    ? 'learn-render 6.4 ReflectionProbe browser evidence'
    : 'learn-render 6.4 CubeCamera browser evidence',
  mode: 'pixel',
  liveHook: '__readReflectionPixels',
  browserReplayHook: '__replayReflectionCapture',
  pixelVerdictOwner: 'browser-fresh',
  capturePrepareHook: reflectionEvidence ? '__captureReflectionProbe' : '__captureRenderTargetReflection',
  appDir: dirname(here),
  warmupMs: reflectionEvidence ? 5000 : 1500,
  navigationWaitUntil: 'domcontentloaded',
  assertCapture: (capture) => {
    if (!capture || typeof capture !== 'object' || !Array.isArray(capture.events)) {
      throw new Error('CubeCamera browser evidence did not capture a tape event stream');
    }
    if (capture.events.length === 0) {
      throw new Error('CubeCamera browser evidence captured no GPU events');
    }
  },
  assertPixels: reflectionEvidence
    ? ({ pixels, width, height }) => {
        const sample = (x, y) => {
          const offset = (y * width + x) * 4;
          return [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0];
        };
        const center = sample(Math.floor(width / 2), Math.floor(height / 2));
        const outside = sample(Math.floor(width * 0.88), Math.floor(height / 2));
        const delta = center.reduce(
          (sum, value, channel) => sum + Math.abs(value - (outside[channel] ?? 0)),
          0,
        );
        if (delta < 8) throw new Error(`probe/outside ROI delta ${delta} is too small`);
      }
    : ({ pixels, width, height }) => {
        const materialPixel = findMaterialSamplingPixel(pixels, width, height);
        if (materialPixel === undefined) {
          throw new Error('CubeCamera material sample did not reach the central reflective object');
        }
        const colors = new Set();
        for (let y = Math.floor(height * 0.3); y < Math.ceil(height * 0.7); y += 8) {
          for (let x = Math.floor(width * 0.3); x < Math.ceil(width * 0.7); x += 8) {
            const sampleOffset = (y * width + x) * 4;
            colors.add([
              pixels[sampleOffset] ?? 0,
              pixels[sampleOffset + 1] ?? 0,
              pixels[sampleOffset + 2] ?? 0,
            ].map((value) => Math.floor(value / 16)).join(','));
          }
        }
        if (colors.size < 3) {
          throw new Error(`CubeCamera display ROI is visually uniform: colors=${colors.size}`);
        }
        const semanticCounts = countSemanticReflectionPixels(pixels, width, height);
        if (semanticCounts.filter((count) => count > 0).length < 3) {
          throw new Error(`CubeCamera semantic reflection colors insufficient: counts=${semanticCounts.join(',')}`);
        }
        const markerPixels = countWhiteMarkerReflectionPixels(pixels, width, height);
        if (markerPixels === 0) {
          throw new Error('CubeCamera +Z L marker reflection was not visible on the central sphere');
        }
        const lowerYellowCount = countLowerYellowReflectionPixels(pixels, width, height);
        if (lowerYellowCount > 0) {
          throw new Error(`CubeCamera lower reflection retained yellow edge pixels: count=${lowerYellowCount}`);
        }
  },
});
if (reflectionEvidence) {
  if (verification?.submittedFrames !== 60) {
    throw new Error(
      `ReflectionProbe browser evidence completed ${verification?.submittedFrames ?? 0} frames; expected 60`,
    );
  }
  console.log(`[learn-render 6.pbr.4] evidence completedFrames=${verification.submittedFrames}`);
}
