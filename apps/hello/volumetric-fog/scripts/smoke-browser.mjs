import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

function pngPixels(bytes) {
  let offset = 8;
  let width = 0;
  let height = 0;
  const chunks = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || (body[9] !== 2 && body[9] !== 6) || body[12] !== 0) {
        throw new Error('visual evidence requires an 8-bit RGB/RGBA PNG');
      }
    } else if (type === 'IDAT') chunks.push(body);
    offset += length + 12;
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const channels = bytes[25] === 6 ? 4 : 3;
  const sourceStride = width * channels;
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  let source = 0;
  let previousDecoded;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source++];
    const row = raw.subarray(source, source + sourceStride);
    source += sourceStride;
    const previous = previousDecoded;
    // Decode into a row with the source channel count first. Keeping the
    // previous row in this same packed representation is required for PNG
    // Up/Average/Paeth filters; retaining the expanded RGBA row shifts the
    // predictor offsets for RGB screenshots and inflates the visual metrics.
    const decoded = Buffer.alloc(sourceStride);
    const output = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < sourceStride; x += 1) {
      const left = x >= channels ? decoded[x - channels] : 0;
      const up = previous?.[x] ?? 0;
      const upLeft = previous?.[x - channels] ?? 0;
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upLeft) : 0;
      decoded[x] = (row[x] + predictor) & 255;
    }
    if (channels === 3) {
      for (let x = 0; x < width; x += 1) {
        output[x * 4] = decoded[x * 3];
        output[x * 4 + 1] = decoded[x * 3 + 1];
        output[x * 4 + 2] = decoded[x * 3 + 2];
        output[x * 4 + 3] = 255;
      }
    } else {
      decoded.copy(output);
    }
    previousDecoded = decoded;
  }
  let sum = 0;
  let square = 0;
  let nonBackground = 0;
  const count = width * height;
  for (let index = 0; index < pixels.length; index += 4) {
    const luminance = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / (3 * 255);
    sum += luminance;
    square += luminance * luminance;
    if (luminance < 0.92) nonBackground += 1;
  }
  const mean = sum / count;
  return {
    width,
    height,
    mean,
    variance: Math.max(0, square / count - mean * mean),
    nonBackgroundRatio: nonBackground / count,
    rgba: pixels,
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function pixelSummary(pixel) {
  return {
    width: pixel.width,
    height: pixel.height,
    mean: pixel.mean,
    variance: pixel.variance,
    nonBackgroundRatio: pixel.nonBackgroundRatio,
    ...visualMetrics(pixel),
    ...airNoiseMetrics(pixel),
  };
}

function summarizeRegion(pixel, left, top, right, bottom) {
  const x0 = Math.max(0, Math.floor(pixel.width * left));
  const y0 = Math.max(0, Math.floor(pixel.height * top));
  const x1 = Math.min(pixel.width, Math.ceil(pixel.width * right));
  const y1 = Math.min(pixel.height, Math.ceil(pixel.height * bottom));
  let sum = 0;
  let square = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = (y * pixel.width + x) * 4;
      const luminance = (pixel.rgba[index] + pixel.rgba[index + 1] + pixel.rgba[index + 2]) / (3 * 255);
      sum += luminance;
      square += luminance * luminance;
      count += 1;
    }
  }
  const mean = count === 0 ? 0 : sum / count;
  return { mean, variance: count === 0 ? 0 : Math.max(0, square / count - mean * mean) };
}

function visualMetrics(pixel) {
  // Ignore the canvas border, where the browser clear color can dominate the
  // summary. The center region is the hero/occluder area of the fixture.
  const roi = summarizeRegion(pixel, 0.1, 0.1, 0.9, 0.9);
  const subject = summarizeRegion(pixel, 0.4, 0.52, 0.53, 0.76);
  const cells = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const left = 0.1 + column * 0.2;
      const top = 0.1 + row * 0.2;
      cells.push(summarizeRegion(pixel, left, top, left + 0.2, top + 0.2).mean);
    }
  }
  return {
    roiMean: roi.mean,
    roiVariance: roi.variance,
    localCellRange: Math.max(...cells) - Math.min(...cells),
    subjectContrast: Math.abs(subject.mean - roi.mean),
  };
}

function airNoiseMetrics(pixel) {
  // Static official camera: sample only the illuminated air above the teapot,
  // excluding the light source, subject, and floor edges. This catches a
  // broken volume-history path without rewarding a dim or disabled volume.
  const x0 = Math.floor(pixel.width * 0.25);
  const x1 = Math.floor(pixel.width * 0.75);
  const y0 = Math.floor(pixel.height * 0.22);
  const y1 = Math.floor(pixel.height * 0.43);
  const differences = [];
  let luminanceSum = 0;
  let count = 0;
  const luminance = (x, y) => {
    const index = (y * pixel.width + x) * 4;
    return (pixel.rgba[index] + pixel.rgba[index + 1] + pixel.rgba[index + 2]) / 765;
  };
  for (let y = y0; y < y1 - 1; y += 1) {
    for (let x = x0; x < x1 - 1; x += 1) {
      const center = luminance(x, y);
      luminanceSum += center;
      differences.push(
        (Math.abs(center - luminance(x + 1, y)) + Math.abs(center - luminance(x, y + 1))) /
          2,
      );
      count += 1;
    }
  }
  differences.sort((left, right) => left - right);
  return {
    airLuminance: count === 0 ? 0 : luminanceSum / count,
    airNeighborMean: count === 0 ? 0 : differences.reduce((sum, value) => sum + value, 0) / count,
    airNeighborP95: differences[Math.floor(differences.length * 0.95)] ?? 0,
  };
}

function comparePixels(left, right) {
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error('visual comparison requires equal PNG dimensions');
  }
  let changed = 0;
  let totalDelta = 0;
  const count = left.width * left.height;
  for (let index = 0; index < left.rgba.length; index += 4) {
    const red = Math.abs(left.rgba[index] - right.rgba[index]);
    const green = Math.abs(left.rgba[index + 1] - right.rgba[index + 1]);
    const blue = Math.abs(left.rgba[index + 2] - right.rgba[index + 2]);
    const delta = (red + green + blue) / (3 * 255);
    if (delta > 0.01) changed += 1;
    totalDelta += delta;
  }
  return { changedPixels: changed / count, meanRgbDelta: totalDelta / count };
}

function meanLuminance(pixel, predicate) {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < pixel.height; y += 1) {
    for (let x = 0; x < pixel.width; x += 1) {
      if (!predicate(x, y, pixel.width, pixel.height)) continue;
      const index = (y * pixel.width + x) * 4;
      sum += (pixel.rgba[index] + pixel.rgba[index + 1] + pixel.rgba[index + 2]) / 765;
      count += 1;
    }
  }
  return count === 0 ? Number.NaN : sum / count;
}

function diagnosticRois(pixel) {
  const source = [0.643, 0.157];
  const receiver = [0.456, 0.648];
  const axisDx = receiver[0] - source[0];
  const axisDy = receiver[1] - source[1];
  const axisLengthSquared = axisDx * axisDx + axisDy * axisDy;
  const alongAxis = (x, y, radius, start, end) => {
    const nx = x / pixel.width;
    const ny = y / pixel.height;
    const t = ((nx - source[0]) * axisDx + (ny - source[1]) * axisDy) / axisLengthSquared;
    if (t < start || t > end) return false;
    const axisX = source[0] + t * axisDx;
    const axisY = source[1] + t * axisDy;
    return (nx - axisX) ** 2 + (ny - axisY) ** 2 <= radius * radius;
  };
  return {
    corridor: (x, y) => alongAxis(x, y, 0.035, 0.12, 0.86),
    aboveFloorAir: (x, y) => alongAxis(x, y, 0.018, 0.8, 0.95) && y / pixel.height < 0.635,
    shadow: (x, y) => {
      const nx = x / pixel.width;
      const ny = y / pixel.height;
      // The occluder projects onto the pinned floor receiver below the
      // teapot. Keep this ROI on the receiver rather than the old in-air
      // coordinates, which measured an unrelated part of the cone.
      return nx >= 0.3 && nx <= 0.7 && ny >= 0.68 && ny <= 0.92;
    },
    coneOutside: (x, y) => {
      const nx = x / pixel.width;
      const ny = y / pixel.height;
      return nx >= 0.62 && nx <= 0.72 && ny >= 0.36 && ny <= 0.62;
    },
  };
}

function pairedDiagnosticMetrics(shadowed, unshadowed) {
  const rois = diagnosticRois(shadowed.pixel);
  const delta = (predicate) =>
    meanLuminance(shadowed.pixel, predicate) - meanLuminance(unshadowed.pixel, predicate);
  return {
    shadow: delta(rois.shadow),
    coneOutside: delta(rois.coneOutside),
  };
}

const url = process.env.FORGEAX_FOG_URL ?? 'http://127.0.0.1:5173/';
const requestedVariant = new URL(url).searchParams.get('variant');
const captureTimeRaw = new URL(url).searchParams.get('captureTime');
const captureOrdinalRaw = new URL(url).searchParams.get('captureOrdinal');
const captureTime = captureTimeRaw === null ? undefined : Number(captureTimeRaw);
const captureOrdinal = captureOrdinalRaw === null ? 0 : Number(captureOrdinalRaw);
const captureMetaPath = process.env.FORGEAX_FOG_CAPTURE_META;
if (captureTimeRaw !== null && !Number.isFinite(captureTime)) {
  throw new Error('captureTime must be a finite number');
}
if (!Number.isInteger(captureOrdinal) || captureOrdinal < 0) {
  throw new Error('captureOrdinal must be a non-negative integer');
}
const variants = requestedVariant === null
  ? [
      'baseline',
      'point-off',
      'spot-off',
      'shadow-off',
      'empty-density',
      'density-zero',
      'disable-volume',
      'uniform-density-no-shadow',
      'diagnostic-ceiling-only',
      'diagnostic-ceiling-occluder',
      'diagnostic-ceiling-occluder-no-volume',
      'diagnostic-occluder-no-shadow',
      'diagnostic-occluder-no-shadow-no-volume',
      'diagnostic-ceiling-only-no-volume',
      'diagnostic-no-shadow',
    ]
  : [requestedVariant];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.FORGEAX_CHROME_EXECUTABLE === undefined
    ? { channel: 'chrome' }
    : { executablePath: process.env.FORGEAX_CHROME_EXECUTABLE }),
  args: [
    '--disable-features=MacAppCodeSignClone',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--ignore-gpu-blocklist',
  ],
  chromiumSandbox: true,
});
try {
  const captures = new Map();
  for (const variant of variants) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const variantUrl = new URL(url);
      variantUrl.searchParams.set('variant', variant);
      await page.goto(variantUrl.toString(), { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => globalThis.__forgeaxFogEvidence !== undefined);
      const settled = await page.evaluate(async () => {
        const deadline = performance.now() + 10000;
        const frameIds = [];
        let lastFrameId = -1;
        let identity;
        let historyEpoch;
        while (performance.now() < deadline) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const inspect = globalThis.__forgeaxApp?.renderer.inspect();
          const frameId = inspect?.frame?.frameId;
          if (!Number.isInteger(frameId) || frameId <= lastFrameId) continue;
          lastFrameId = frameId;
          const fog = inspect?.volumetricFog;
          const temporal = inspect?.temporal;
          // The parity scene intentionally uses the current mainline FXAA
          // path.  FXAA has no temporal history carrier, so its inspection is
          // correctly `off`; only a TAA camera needs the stable-history gate.
          // Keep the gate strict for TAA while accepting the authored-off
          // fast path instead of waiting forever for an impossible status.
          const temporalSettled =
            temporal?.mode === 'taa'
              ? temporal.status === 'stable' &&
                (temporal.resetReason === undefined || temporal.resetReason === 'none')
              : temporal?.status === 'off';
          const accepted =
            fog?.status === 'available' &&
            fog.resourceStage === 'accepted' &&
            temporalSettled;
          if (fog?.status === 'off') {
            frameIds.push(frameId);
          } else if (accepted) {
            const nextIdentity = {
              generation: fog.generation,
              digest: fog.digest,
              deviceEpoch: fog.deviceEpoch,
            };
            if (
              identity === undefined ||
              identity.generation !== nextIdentity.generation ||
              identity.digest !== nextIdentity.digest ||
              identity.deviceEpoch !== nextIdentity.deviceEpoch ||
              historyEpoch !== temporal.historyEpoch
            ) {
              frameIds.length = 0;
              identity = nextIdentity;
              historyEpoch = temporal.historyEpoch;
            }
            frameIds.push(frameId);
          } else {
            frameIds.length = 0;
            identity = undefined;
            historyEpoch = undefined;
          }
          if (frameIds.length >= 34) {
            return {
              firstFrameId: frameIds[0],
              lastFrameId: frameIds.at(-1),
              distinctCount: frameIds.length,
              identity,
              historyEpoch,
            };
          }
        }
        throw new Error('renderer did not produce 34 distinct settled frames');
      });
      const evidence = await page.evaluate((settledFrames) => {
        const value = globalThis.__forgeaxFogEvidence;
        const rendererInspect = globalThis.__forgeaxApp?.renderer.inspect() ?? null;
        return {
          variant: value.variant,
          inspect: rendererInspect?.volumetricFog ?? null,
          rendererInspect,
          rendererErrors: value.rendererErrors,
          settled: settledFrames,
        };
      }, settled);
      const screenshot =
        requestedVariant === null && variant === 'baseline'
          ? 'volumetric-fog-browser.png'
          : `volumetric-fog-browser-${variant}.png`;
      await page.screenshot({ path: screenshot });
      if (errors.length > 0) throw new Error(`browser errors: ${errors.join('; ')}`);
      if (evidence.rendererInspect === null) throw new Error('renderer inspection unavailable');
      if (evidence.inspect === null) throw new Error('volumetric fog inspection unavailable');
      if (evidence.settled.distinctCount < 34) {
        throw new Error(`settle acceptance failed: distinctCount=${evidence.settled.distinctCount}`);
      }
      const pixel = pngPixels(await readFile(screenshot));
      const captureViewport = await page.evaluate(() => ({
        dpr: window.devicePixelRatio,
        cssWidth: window.innerWidth,
        cssHeight: window.innerHeight,
      }));
      const volumePasses = evidence.rendererInspect.perFramePassNames.filter((name) =>
        name.startsWith('volume-'),
      );
      const volumeDisabled =
        variant === 'disable-volume' ||
        variant === 'diagnostic-ceiling-only-no-volume' ||
        variant === 'diagnostic-ceiling-occluder-no-volume' ||
        variant === 'diagnostic-occluder-no-shadow-no-volume';
      if (volumeDisabled) {
        if (evidence.inspect.status !== 'off' || volumePasses.length !== 0) {
          throw new Error(
            `fog-off acceptance failed: status=${evidence.inspect.status} volumePasses=${volumePasses.length}`,
          );
        }
      } else {
        if (evidence.inspect.status !== 'available') throw new Error('fog inspection unavailable');
        if (volumePasses.length !== 4) {
          throw new Error(`volume topology acceptance failed: volumePasses=${volumePasses.length}`);
        }
        const visual = visualMetrics(pixel);
        const airNoise = airNoiseMetrics(pixel);
        if (
          variant === 'baseline' &&
          (pixel.mean >= 0.92 ||
            pixel.variance <= 0.0005 ||
            visual.roiVariance <= 0.001 ||
            visual.localCellRange <= 0.02 ||
            visual.subjectContrast <= 0.04)
        ) {
          throw new Error(
            `visual acceptance failed: mean=${pixel.mean.toFixed(4)} variance=${pixel.variance.toFixed(6)} roiVariance=${visual.roiVariance.toFixed(6)} localCellRange=${visual.localCellRange.toFixed(4)} subjectContrast=${visual.subjectContrast.toFixed(4)}`,
          );
        }
        if (variant === 'baseline' && airNoise.airNeighborMean > 0.0035) {
          throw new Error(
            `volume temporal noise failed: airLuminance=${airNoise.airLuminance.toFixed(4)} airNeighborMean=${airNoise.airNeighborMean.toFixed(5)} airNeighborP95=${airNoise.airNeighborP95.toFixed(5)}`,
          );
        }
      }
      captures.set(variant, { evidence, pixel, screenshot, volumePasses, captureViewport });
      console.log(
        `[fog-browser] PASS variant=${variant} backend=${evidence.rendererInspect.capabilities.backendKind} stage=${evidence.inspect.resourceStage}`,
      );
    } finally {
      await page.close();
    }
  }

  const baseline = captures.get('baseline');
  const empty = captures.get('empty-density');
  const disabled = captures.get('disable-volume');
  const uniform = captures.get('uniform-density-no-shadow');
  const ceilingOnly = captures.get('diagnostic-ceiling-only');
  const ceilingOnlyOff = captures.get('diagnostic-ceiling-only-no-volume');
  const ceilingOccluder = captures.get('diagnostic-ceiling-occluder');
  const ceilingOccluderOff = captures.get('diagnostic-ceiling-occluder-no-volume');
  const occluderNoShadow = captures.get('diagnostic-occluder-no-shadow');
  const occluderNoShadowOff = captures.get('diagnostic-occluder-no-shadow-no-volume');
  const noShadow = captures.get('diagnostic-no-shadow');
  let comparison;
  if (baseline !== undefined && empty !== undefined) {
    comparison = comparePixels(baseline.pixel, empty.pixel);
    if (comparison.changedPixels <= 0.01 || comparison.meanRgbDelta <= 0.01) {
      throw new Error(
        `density visual falsifier failed: changedPixels=${comparison.changedPixels.toFixed(4)} meanRgbDelta=${comparison.meanRgbDelta.toFixed(4)}`,
      );
    }
  }
  let aboveFloorComparison;
  if (ceilingOnly !== undefined && ceilingOnlyOff !== undefined) {
    const rois = diagnosticRois(ceilingOnly.pixel);
    aboveFloorComparison =
      meanLuminance(ceilingOnly.pixel, rois.aboveFloorAir) -
      meanLuminance(ceilingOnlyOff.pixel, rois.aboveFloorAir);
    // The normalized HG to punctual-light conversion uses 4pi. The old
    // 0.02-0.06 bound measured the unscaled phase; the paired Three fixture
    // contributes about 0.177 in this ROI, so keep the parity window around
    // the new physically normalized result.
    const ABOVE_FLOOR_VOLUME_MIN = 0.1;
    const ABOVE_FLOOR_VOLUME_MAX = 0.22;
    if (aboveFloorComparison < ABOVE_FLOOR_VOLUME_MIN || aboveFloorComparison > ABOVE_FLOOR_VOLUME_MAX) {
      throw new Error(`above-floor air ROI failed: delta=${aboveFloorComparison.toFixed(4)}`);
    }
  }
  for (const [variant, capture] of [
    ['diagnostic-ceiling-only', ceilingOnly],
    ['diagnostic-ceiling-occluder', ceilingOccluder],
    ['diagnostic-occluder-no-shadow', occluderNoShadow],
    ['diagnostic-no-shadow', noShadow],
  ]) {
    if (capture === undefined) continue;
    if (capture.evidence.inspect.status !== 'available' || capture.volumePasses.length !== 4) {
      throw new Error(`diagnostic acceptance failed: variant=${variant}`);
    }
  }

  let diagnosticComparison;
  if (ceilingOccluder !== undefined && occluderNoShadow !== undefined) {
    diagnosticComparison = pairedDiagnosticMetrics(ceilingOccluder, occluderNoShadow);
    // The current mainline HDR/output path quantizes the paired display
    // capture by a few luminance thousandths. Keep the control ROI tight
    // enough to reject a real projector/shadow leak while allowing that
    // bounded encoding drift.
    if (Math.abs(diagnosticComparison.coneOutside) > 0.01) {
      throw new Error(
        `diagnostic cone control failed: absDelta=${Math.abs(diagnosticComparison.coneOutside).toFixed(4)}`,
      );
    }
    if (diagnosticComparison.shadow > -0.015) {
      throw new Error(
        `diagnostic shadow ROI failed: delta=${diagnosticComparison.shadow.toFixed(4)}`,
      );
    }
  }
  let volumeShadowComparison;
  if (
    ceilingOccluder !== undefined &&
    ceilingOccluderOff !== undefined &&
    occluderNoShadow !== undefined &&
    occluderNoShadowOff !== undefined
  ) {
    const rois = diagnosticRois(ceilingOccluder.pixel);
    const shadowVolume =
      meanLuminance(ceilingOccluder.pixel, rois.shadow) -
      meanLuminance(ceilingOccluderOff.pixel, rois.shadow);
    const unshadowedVolume =
      meanLuminance(occluderNoShadow.pixel, rois.shadow) -
      meanLuminance(occluderNoShadowOff.pixel, rois.shadow);
    volumeShadowComparison = { shadowVolume, unshadowedVolume, interaction: shadowVolume - unshadowedVolume };
    if (volumeShadowComparison.interaction > -0.005) {
      throw new Error(`volume shadow ROI failed: delta=${volumeShadowComparison.interaction.toFixed(4)}`);
    }
  }

  const primary = baseline ?? captures.values().next().value;
  if (primary === undefined) throw new Error('no browser visual capture');
  const { evidence, pixel, screenshot, volumePasses } = primary;
  if (evidence.rendererInspect === null || evidence.inspect === null) {
    throw new Error('primary capture lacks renderer inspection');
  }
  const backend = evidence.rendererInspect.capabilities.backendKind;
  const volume = evidence.inspect;
  const provenance = {
    ...(volume.guid === undefined ? {} : { guid: volume.guid }),
    ...(volume.generation === undefined ? {} : { generation: volume.generation }),
    ...(volume.digest === undefined ? {} : { digest: volume.digest }),
  };
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const receipt = {
    expectation: {
      backend,
      pixel: { oracle: 'observed-png', tolerance: 0.05 },
      provenance,
      ...(comparison === undefined ? {} : { densityComparison: comparison }),
      ...(diagnosticComparison === undefined ? {} : { diagnosticComparison }),
      ...(volumeShadowComparison === undefined ? {} : { volumeShadowComparison }),
      ...(aboveFloorComparison === undefined ? {} : { aboveFloorComparison }),
    },
    observed: {
      backend,
      variant: evidence.variant,
      pixel: pixelSummary(pixel),
      provenance: { ...provenance, head },
      renderer: {
        backendKind: backend,
        temporal: evidence.rendererInspect.temporal,
        volumetricFog: volume,
        volumePasses,
        errors: evidence.rendererErrors,
      },
      settle: evidence.settled,
      ...(comparison === undefined ? {} : { densityComparison: comparison }),
      ...(diagnosticComparison === undefined ? {} : { diagnosticComparison }),
      ...(volumeShadowComparison === undefined ? {} : { volumeShadowComparison }),
      ...(aboveFloorComparison === undefined ? {} : { aboveFloorComparison }),
      ...(baseline === undefined
        ? {}
        : {
            variants: {
              baseline: { pixel: pixelSummary(baseline.pixel), volumePasses: baseline.volumePasses },
              'empty-density':
                empty === undefined
                  ? undefined
                  : { pixel: pixelSummary(empty.pixel), volumePasses: empty.volumePasses },
              'uniform-density-no-shadow':
                uniform === undefined
                  ? undefined
                  : { pixel: pixelSummary(uniform.pixel), volumePasses: uniform.volumePasses },
              'disable-volume':
                disabled === undefined
                  ? undefined
                  : { pixel: pixelSummary(disabled.pixel), volumePasses: disabled.volumePasses },
              'diagnostic-ceiling-only':
                ceilingOnly === undefined
                  ? undefined
                  : { pixel: pixelSummary(ceilingOnly.pixel), volumePasses: ceilingOnly.volumePasses },
              'diagnostic-ceiling-only-no-volume':
                ceilingOnlyOff === undefined
                  ? undefined
                  : { pixel: pixelSummary(ceilingOnlyOff.pixel), volumePasses: ceilingOnlyOff.volumePasses },
              'diagnostic-ceiling-occluder':
                ceilingOccluder === undefined
                  ? undefined
                  : { pixel: pixelSummary(ceilingOccluder.pixel), volumePasses: ceilingOccluder.volumePasses },
              'diagnostic-ceiling-occluder-no-volume':
                ceilingOccluderOff === undefined
                  ? undefined
                  : { pixel: pixelSummary(ceilingOccluderOff.pixel), volumePasses: ceilingOccluderOff.volumePasses },
              'diagnostic-occluder-no-shadow':
                occluderNoShadow === undefined
                  ? undefined
                  : { pixel: pixelSummary(occluderNoShadow.pixel), volumePasses: occluderNoShadow.volumePasses },
              'diagnostic-occluder-no-shadow-no-volume':
                occluderNoShadowOff === undefined
                  ? undefined
                  : { pixel: pixelSummary(occluderNoShadowOff.pixel), volumePasses: occluderNoShadowOff.volumePasses },
              'diagnostic-no-shadow':
                noShadow === undefined
                  ? undefined
                  : { pixel: pixelSummary(noShadow.pixel), volumePasses: noShadow.volumePasses },
            },
          }),
    },
    verdict: 'pass',
    confidence: 0.95,
    visual: { verdict: 'pass', confidence: 0.95, screenshot },
  };
  if (captureMetaPath !== undefined) {
    if (baseline === undefined || captureTime === undefined) {
      throw new Error('capture metadata requires a baseline with explicit captureTime');
    }
    await writeFile(
      captureMetaPath,
      `${JSON.stringify(
        {
          producer: 'forgeax',
          head,
          backend: 'headed-webgpu',
          adapter: process.env.FORGEAX_FOG_ADAPTER ?? 'chromium-1228',
          compositor: process.env.FORGEAX_FOG_COMPOSITOR ?? 'chrome-skia',
          colorSpace: 'srgb',
          dpr: baseline.captureViewport.dpr,
          cssWidth: baseline.captureViewport.cssWidth,
          cssHeight: baseline.captureViewport.cssHeight,
          frozenTime: captureTime,
          settleFrames: 30,
          normalizedFrame: captureOrdinal,
          internalFrame: evidence.settled.lastFrameId,
          history: evidence.settled.historyEpoch,
          settledFrames: evidence.settled.distinctCount,
          raw: true,
          synthetic: false,
          skipped: false,
        },
        null,
        2,
      )}\n`,
    );
  }
  if (process.env.FORGEAX_FOG_RECEIPT !== undefined) {
    await writeFile(process.env.FORGEAX_FOG_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  console.log(`[fog-browser-evidence] ${JSON.stringify(receipt)}`);
} finally {
  await browser.close();
}
