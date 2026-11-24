import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodePng } from '@forgeax/engine-image/png';
import { expect } from 'vitest';
import { SCREEN_PROBE_RECORD_BYTES } from '../../raytracing/screen-probe-plan';
import { packPointRadiance } from './screen-probe-radiance.fixture';

export type NeighborReconstructionCase =
  | 'complete'
  | 'missing-neighbor'
  | 'incomplete-neighbor'
  | 'all-incomplete'
  | 'all-black'
  | 'known-black'
  | 'visibility-rejected'
  | 'partial-edge';

/** Author logical point packets, not a replacement for the production query.
 * Unknown RGB is deliberately bright: neither its numerator nor its measure
 * may become an observed black/bright sample during spatial reconstruction.
 */
export function neighborRadiance(
  probes: number,
  kind: NeighborReconstructionCase,
  knownProbe: number,
  tilesX: number,
): Float32Array {
  const values = new Float32Array(probes * 64 * 8);
  for (let probe = 0; probe < probes; probe++) {
    const known =
      kind === 'complete' ||
      kind === 'all-black' ||
      kind === 'known-black' ||
      kind === 'visibility-rejected' ||
      (kind !== 'all-incomplete' && probe === knownProbe);
    const support = known ? 1 : kind === 'missing-neighbor' ? 0 : -1;
    let value = known ? 0.5 : 123;
    if (kind === 'all-black') value = 0;
    if (kind === 'known-black') value = probe % tilesX === 0 ? 1 : 0;
    if (kind === 'visibility-rejected') value = probe % tilesX === 0 ? 0.5 : 123;
    for (let texel = 0; texel < 64; texel++)
      values.set([value, value, value, support, -1, 1, 0, 0], (probe * 64 + texel) * 8);
  }
  return values;
}

/** Constant reproduction does not depend on the implementation's tap weights.
 * For the complete white/black rectangle only, linear precision independently
 * fixes its value from the actual placed left/right sample coordinates.
 * Completion below describes authored observations, never output alpha.
 */
export function neighborExpectation(
  kind: NeighborReconstructionCase,
  worldX: number,
  left: number,
  right: number,
) {
  return {
    rgb:
      kind === 'all-incomplete' || kind === 'all-black'
        ? 0
        : kind === 'known-black'
          ? Math.max(0, Math.min(1, (right - worldX) / (right - left)))
          : 0.5,
    sourceComplete:
      kind === 'complete' ||
      kind === 'known-black' ||
      kind === 'all-black' ||
      kind === 'visibility-rejected',
    unknownIsObservation: false,
    outputAlphaIsCompletionCertificate: false,
  } as const;
}

/** Three panels: actual GPU RGB, independent constant/linear oracle, and
 * source completion (green=all authored samples known, magenta=unknown).
 * This is a readback data atlas, not a rendered scene or a GI acceptance image.
 */
export function neighborAtlas(
  width: number,
  height: number,
  actual: Float32Array,
  expected: readonly number[],
  complete: boolean,
): Uint8Array {
  const scale = 12;
  const atlasWidth = width * 3 * scale;
  const atlasHeight = height * scale;
  const rgba = new Uint8Array(atlasWidth * atlasHeight * 4);
  for (let y = 0; y < atlasHeight; y++) {
    for (let x = 0; x < atlasWidth; x++) {
      const panel = Math.floor(x / (width * scale));
      const pixel = Math.floor(y / scale) * width + (Math.floor(x / scale) % width);
      const first = (y * atlasWidth + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const value = panel === 0 ? actual[pixel * 4 + channel] : expected[pixel];
        rgba[first + channel] =
          panel === 2
            ? complete
              ? channel === 1
                ? 255
                : 0
              : channel === 1
                ? 0
                : 255
            : panel === 1 && !Number.isFinite(value)
              ? channel === 2
                ? 255
                : 0
              : Math.round(Math.max(0, Math.min(1, value ?? 0)) * 255);
      }
      rgba[first + 3] = 255;
    }
  }
  return encodePng(atlasWidth, atlasHeight, rgba);
}

export interface ReconstructionNeighborRig {
  readonly partialEdge: boolean;
  readonly device: GPUDevice;
  readonly adapterInfo: GPUAdapterInfo;
  readonly width: number;
  readonly height: number;
  readonly tilesX: number;
  readonly probeCount: number;
  readonly input: GPUBuffer;
  readonly probes: GPUBuffer;
  readonly integrated: GPUBuffer;
  readonly writeFrame: (candidate: boolean) => Uint8Array;
  readonly execute: (
    entry: 'placeUniformProbes' | 'integrateScreenProbes',
    source: GPUBuffer,
  ) => Promise<Uint8Array>;
}

type NeighborSample = {
  readonly pixel: readonly [number, number];
  readonly oracle: ReturnType<typeof neighborExpectation>;
  readonly actual: readonly number[];
};
type NeighborRow = {
  readonly kind: NeighborReconstructionCase;
  readonly candidate: boolean;
  readonly samples: readonly NeighborSample[];
};

function assertNeighborSample(row: NeighborRow, sample: NeighborSample) {
  const unavailable =
    row.kind === 'all-incomplete' ||
    (!row.candidate && ['incomplete-neighbor', 'partial-edge'].includes(row.kind));
  if (unavailable) {
    expect(sample.actual).toEqual([0, 0, 0, 0]);
    return;
  }
  for (let channel = 0; channel < 3; channel++)
    expect(sample.actual[channel], `${row.kind}:${row.candidate}:${sample.pixel}`).toBeCloseTo(
      sample.oracle.rgb,
      3,
    );
  const tag = sample.actual[3] ?? Number.NaN;
  if (!row.candidate) {
    expect(tag).toBe(1);
    return;
  }
  expect(tag).toBeGreaterThan(2);
  expect(tag).toBeLessThanOrEqual(3);
  // This is measured support confidence, never strict completion alpha=1.
  if (['missing-neighbor', 'incomplete-neighbor', 'partial-edge'].includes(row.kind))
    expect(tag).toBeLessThan(3);
}

export async function runNeighborReconstruction(rig: ReconstructionNeighborRig) {
  const directory =
    process.env.FORGEAX_SCREEN_RECONSTRUCTION_EVIDENCE_DIR ??
    'artifacts/screen-probe/reconstruction/neighbors';
  mkdirSync(directory, { recursive: true });
  const label = rig.partialEdge ? 'partial17x13' : 'mixed8x8';
  rig.writeFrame(false);
  const placed = await rig.execute('placeUniformProbes', rig.probes);
  writeFileSync(`${directory}/${label}-placed.bin`, placed);
  const positions = new Float32Array(placed.buffer);
  const kinds: readonly NeighborReconstructionCase[] = rig.partialEdge
    ? ['partial-edge']
    : [
        'complete',
        'missing-neighbor',
        'incomplete-neighbor',
        'all-incomplete',
        'all-black',
        'known-black',
      ];
  const rows: NeighborRow[] = [];
  const readbacks: EdgeReadback[] = [];
  for (const kind of kinds) {
    const logical = neighborRadiance(
      rig.probeCount,
      kind,
      rig.partialEdge ? rig.probeCount - 1 : 0,
      rig.tilesX,
    );
    const packets = packPointRadiance(logical, rig.probeCount);
    writeFileSync(`${directory}/${label}-${kind}-packets.bin`, new Uint8Array(packets.buffer));
    rig.device.queue.writeBuffer(rig.input, 0, packets);
    for (const candidate of [false, true]) {
      const name = `${label}-${kind}-${candidate ? 'current' : 'strict'}`;
      const frame = rig.writeFrame(candidate);
      const flags = new Uint32Array(frame.buffer, frame.byteOffset)[10];
      expect(flags).toBe(candidate ? 24 : 0);
      writeFileSync(`${directory}/${name}-frame.bin`, frame);
      const raw = await rig.execute('integrateScreenProbes', rig.integrated);
      writeFileSync(`${directory}/${name}-integrated.bin`, raw);
      const actual = new Float32Array(raw.buffer);
      readbacks.push({ candidate, values: actual });
      const expected = Array<number>(rig.width * rig.height).fill(Number.NaN);
      if (rig.partialEdge) {
        // The penultimate probe row lands exactly at y=11, so this pixel
        // receives no weight from the last-row donor. Keep it as a negative
        // control while the adjacent last-row pixel has mixed horizontal taps.
        const probeWords = new Uint32Array(placed.buffer);
        const donorAbove = (rig.probeCount - 1 - rig.tilesX) * (SCREEN_PROBE_RECORD_BYTES / 4);
        const packed = probeWords[donorAbove + 7] ?? 0;
        expect(packed >>> 16).toBe(rig.height - 2);
        const absent = ((rig.height - 2) * rig.width + rig.width - 2) * 4;
        expect(Array.from(actual.slice(absent, absent + 4))).toEqual([0, 0, 0, 0]);
      }
      const pixels: readonly (readonly [number, number])[] = rig.partialEdge
        ? [[rig.width - 2, rig.height - 1]]
        : [
            [1, 1],
            [2, 1],
            [1, 2],
          ];
      const samples = pixels.map(([x, y]) => {
        const oracle = neighborExpectation(
          kind,
          ((x + 0.5) * 2) / rig.width - 1,
          positions[0] ?? NaN,
          positions[SCREEN_PROBE_RECORD_BYTES / 4] ?? NaN,
        );
        const pixel = y * rig.width + x;
        expected[pixel] =
          !candidate && ['all-incomplete', 'incomplete-neighbor', 'partial-edge'].includes(kind)
            ? 0
            : oracle.rgb;
        return {
          pixel: [x, y] as const,
          oracle,
          actual: Array.from(actual.slice(pixel * 4, pixel * 4 + 4)),
        };
      });
      writeFileSync(
        `${directory}/${name}-atlas.png`,
        neighborAtlas(
          rig.width,
          rig.height,
          actual,
          expected,
          samples[0]?.oracle.sourceComplete ?? false,
        ),
      );
      rows.push({ kind, candidate, samples });
    }
  }
  writeFileSync(
    `${directory}/${label}-result.json`,
    JSON.stringify(
      {
        scope:
          'Authored current-frame receiver/data reconstruction; no HW intersection, canonical contact, temporal or scene acceptance',
        adapterInfo: rig.adapterInfo,
        deviceFeatures: [...rig.device.features],
        histories: { scene: false, pixel: false, probe: false },
        confidence:
          'Output alpha in (2,3] is reconstruction confidence, never strict alpha=1 or a completion certificate',
        atlas: [
          'Actual GPU RGB clamp0..1',
          'Independent constant/linear oracle, blue unchecked',
          'Authored source completion',
        ],
        rows,
      },
      null,
      2,
    ),
  );
  assertPartialEdgeRig(rig, positions, readbacks, directory);
  for (const row of rows) for (const sample of row.samples) assertNeighborSample(row, sample);
}

// Independent coherent-rectangle reference: no production uniformTaps calls.
// Rounded UV division, exact factor2 and rounded add give the controlled
// orthographic identity-XY/w reconstruction its absolute position bound3u.
type EdgeState = 'VALID' | 'UNAVAILABLE' | 'UNJUDGED';
interface EdgeReadback {
  readonly candidate: boolean;
  readonly values: Float32Array;
}
const U = 2 ** -24,
  POSITION_ERROR = 3 * U,
  TAP_CUT = 1e-4,
  TOTAL_CUT = 1e-3;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
export function edgeHatDomain(width: number, height: number, placed: Float32Array) {
  const stride = SCREEN_PROBE_RECORD_BYTES / 4,
    tilesX = Math.ceil(width / 4),
    tilesY = Math.ceil(height / 4),
    count = tilesX * tilesY;
  assert.equal(placed.byteLength, count * SCREEN_PROBE_RECORD_BYTES);
  const words = new Uint32Array(placed.buffer, placed.byteOffset, placed.length);
  const vector = (o: number) =>
    [placed[o] ?? NaN, placed[o + 1] ?? NaN, placed[o + 2] ?? NaN] as const;
  const at = (i: number) => {
    assert(Number.isSafeInteger(i) && i >= 0 && i < count);
    const pixel = words[i * stride + 7] ?? 0xffffffff;
    return {
      index: i,
      position: vector(i * stride),
      normal: vector(i * stride + 4),
      pixel: [pixel & 65535, pixel >>> 16] as const,
    };
  };
  const known = at(count - 1),
    left = at(count - 2),
    up = at(count - 1 - tilesX),
    diagonal = at(count - 2 - tilesX);
  assert.deepEqual(known.pixel, [width - 1, height - 1]);
  assert.equal(left.pixel[1], known.pixel[1]);
  assert.equal(up.pixel[0], known.pixel[0]);
  assert(known.position[0] > left.position[0]);
  assert(up.position[1] > known.position[1]);
  assert.equal(known.position[1], left.position[1]);
  assert.equal(known.position[0], up.position[0]);
  assert.equal(diagonal.position[0], left.position[0]);
  assert.equal(diagonal.position[1], up.position[1]);
  for (let i = 0; i < count; i++) {
    const p = at(i);
    assert.equal(p.position[2], 0);
    assert(p.pixel[0] < width && p.pixel[1] < height);
    assert(Math.abs(p.position[0] - ((2 * p.pixel[0] + 1) / width - 1)) <= POSITION_ERROR);
    assert(Math.abs(p.position[1] - (1 - (2 * p.pixel[1] + 1) / height)) <= POSITION_ERROR);
    assert.deepEqual(p.normal, known.normal);
  }
  const norm = known.normal.reduce((s, v) => s + v * v, 0);
  assert(norm > 0.99 && norm < 1.01);
  const planeUpper =
    (2 * (Math.abs(known.normal[0]) + Math.abs(known.normal[1]))) / Math.fround(0.03);
  // Deferred RGB10 quantization tilts the authored +Z normal slightly. Bound
  // agreement over the whole plane and use that bound in the support oracle.
  const agreementLow = Math.exp(-planeUpper * planeUpper) * Math.min(1, norm) ** 4 - 32 * U;
  assert(
    agreementLow > 0.97,
    'Controlled same-plane normal has positive agreement far from rejection',
  );
  return {
    width,
    height,
    known,
    left,
    up,
    diagonal,
    positionError: POSITION_ERROR,
    unitRoundoff: U,
    positionBound:
      'Orthographic identity inverseVP: rounded UV division then exact factor2 and rounded add; <=3*2^-24 absolute. w=1,z=0 exact.',
    planeUpper,
    normalSquare: norm,
    agreementLow,
  };
}
export function edgeHatExpectation(domain: ReturnType<typeof edgeHatDomain>, x: number, y: number) {
  const { known, left, up, width, height } = domain;
  const dx = known.position[0] - left.position[0],
    dy = up.position[1] - known.position[1];
  const px = (2 * x + 1) / width - 1,
    py = 1 - (2 * y + 1) / height;
  const u = clamp((x - left.pixel[0]) / (known.pixel[0] - left.pixel[0])),
    v = clamp((y - up.pixel[1]) / (known.pixel[1] - up.pixel[1]));
  const hat = u * v;
  const ulo = clamp((px - POSITION_ERROR - left.position[0]) / dx),
    uhi = clamp((px + POSITION_ERROR - left.position[0]) / dx),
    vlo = clamp((up.position[1] - py - POSITION_ERROR) / dy),
    vhi = clamp((up.position[1] - py + POSITION_ERROR) / dy);
  const hatLow = ulo * vlo,
    high = uhi * vhi;
  const low = hatLow * domain.agreementLow;
  const exactKnownPixel = x === known.pixel[0] && y === known.pixel[1];
  let current: EdgeState = 'UNJUDGED',
    strict: EdgeState = 'UNJUDGED';
  if (high < TAP_CUT) {
    current = 'UNAVAILABLE';
    strict = 'UNAVAILABLE';
  } else if (low > TOTAL_CUT) {
    current = 'VALID';
    if (exactKnownPixel) strict = 'VALID';
    else if ((1 - high) * domain.agreementLow > 3 * TAP_CUT) strict = 'UNAVAILABLE';
  }
  return {
    x,
    y,
    region:
      (x === 0 || x === width - 1) && (y === 0 || y === height - 1)
        ? 'corner'
        : x === 0 || x === width - 1 || y === 0 || y === height - 1
          ? 'edge'
          : 'interior',
    hat,
    weightBounds: [low, high],
    current,
    strict,
    exactKnownPixel,
  };
}
export function checkEdgeHatPixel(
  expected: ReturnType<typeof edgeHatExpectation>,
  candidate: boolean,
  actual: readonly number[],
) {
  const state = candidate ? expected.current : expected.strict;
  if (state === 'UNJUDGED') return { checked: false, ok: true, error: 0 };
  if (state === 'UNAVAILABLE') return { checked: true, ok: actual.every((v) => v === 0), error: 0 };
  const error = Math.max(...actual.slice(0, 3).map((v) => Math.abs(v - 0.5)));
  const a = actual[3] ?? NaN;
  const tag = candidate ? a > 2 && a <= 3 && (expected.exactKnownPixel || a < 3) : a === 1;
  return { checked: true, ok: tag && error < 0.0005, error };
}

export function assessReconstructionEdge(
  width: number,
  height: number,
  placed: Float32Array,
  outputs: readonly EdgeReadback[],
) {
  assert.deepEqual(outputs.map((output) => output.candidate).sort(), [false, true]);
  for (const output of outputs) assert.equal(output.values.length, width * height * 4);
  const domain = edgeHatDomain(width, height, placed);
  const checks = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const expected = edgeHatExpectation(domain, x, y),
        index = (y * width + x) * 4;
      for (const output of outputs) {
        const actual = Array.from(output.values.slice(index, index + 4));
        checks.push({
          expected,
          candidate: output.candidate,
          actual,
          ...checkEdgeHatPixel(expected, output.candidate, actual),
        });
      }
    }
  return {
    domain,
    checked: checks.filter((check) => check.checked).length,
    unjudged: checks.filter((check) => !check.checked).length,
    maximumError: Math.max(...checks.map((check) => check.error)),
    failures: checks.filter((check) => !check.ok),
  };
}

function assertPartialEdgeRig(
  rig: ReconstructionNeighborRig,
  placed: Float32Array,
  outputs: readonly EdgeReadback[],
  directory: string,
) {
  if (!rig.partialEdge) return;
  const result = assessReconstructionEdge(rig.width, rig.height, placed, outputs);
  writeFileSync(`${directory}/partial17x13-full-domain.json`, JSON.stringify(result, null, 2));
  expect(result.unjudged).toBe(0);
  expect(result.failures).toEqual([]);
  expect(result.checked).toBe(rig.width * rig.height * 2);
}
