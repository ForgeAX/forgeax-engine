import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from '@forgeax/engine-image/png';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, assert, expect, it } from 'vitest';
import { screenProbeWorldWgsl } from '../../../render/src/raytracing/screen-probe-kernels';
import { SCREEN_PROBE_RECORD_BYTES } from '../../../render/src/raytracing/screen-probe-plan';
import { resolveVisibleSurfaceRange } from '../../../render/src/raytracing/visible-surface';
import {
  checkCanonicalReceiver,
  exactNearBlocker,
  screenCanonicalScene,
} from './screen-canonical-receiver.fixture';
import {
  checkScreenWorldHit,
  decodeScreenWorldHit,
  exactCanonicalWorld,
} from './screen-canonical-world-oracle.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const path = process.env.FORGEAX_SCREEN_CANONICAL_MANIFEST;
const manifest =
  path === undefined
    ? shaderManifestUrl(await buildEngineShaderManifest())
    : URL.createObjectURL(new Blob([readFileSync(path, 'utf8')], { type: 'application/json' }));
afterAll(() => URL.revokeObjectURL(manifest));
type Harness = Awaited<ReturnType<typeof screenCanonicalScene>>;
type Sample = Awaited<ReturnType<Harness['receiverImage']>>;
const sha = (source: string) => createHash('sha256').update(source).digest('hex');
const wordsOf = (bytes: Uint8Array) =>
  new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
const status = (words: Uint32Array, ray: number) => ((words[ray * 8 + 3] ?? 0) >>> 12) & 7;

function rasterPng(rgb: Float32Array, width: number, height: number) {
  const bytes = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < 3; c++) {
      const value = rgb[p * 3 + c] ?? NaN;
      assert(Number.isFinite(value) && value >= 0);
      const encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
      bytes[p * 4 + c] = Math.round(Math.min(1, encoded) * 255);
    }
    bytes[p * 4 + 3] = 255;
  }
  return encodePng(width, height, bytes);
}

function receiverRecords(h: Harness, sample: Sample, name: string) {
  const observation = JSON.parse(
    readFileSync(join(h.directory, `${name}-observation.json`), 'utf8'),
  );
  const visible = wordsOf(readFileSync(join(h.directory, `${name}-visible.rgba32uint`)));
  const records = wordsOf(readFileSync(join(h.directory, `${name}-visible-records.u32`)));
  const probes = new Uint32Array(sample.probes),
    frame = new Uint32Array(sample.frame),
    source = wordsOf(sample.source);
  expect(Array.from(source.subarray(4, 8))).toEqual(Array.from(frame.subarray(44, 48)));
  expect(source[3]).toBe(frame[7]);
  expect(source[10]).toBe(frame[22]);
  const ready = [];
  for (let p = 0; p < sample.probes.byteLength / SCREEN_PROBE_RECORD_BYTES; p++) {
    const at = (p * SCREEN_PROBE_RECORD_BYTES) / 4;
    if (probes[at + 20] !== 1) continue;
    const pixel = probes[at + 7] ?? 0xffffffff,
      x = pixel & 65535,
      y = pixel >>> 16;
    const address = (y * observation.visible.bytesPerRow + x * 16) / 4,
      rasterRow = visible[address] ?? 0;
    expect(probes[at + 22]).toBe(rasterRow);
    expect(probes[at + 21]).toBe(frame[7]);
    const range = resolveVisibleSurfaceRange({ records }, rasterRow).unwrap();
    assert(range);
    const authored = h.authored.find((row) => row.handle === range.assetHandle);
    assert(authored);
    const primitive = range.firstElement / 3 + (visible[address + 1] ?? NaN);
    expect(probes[at + 15]).toBe(primitive);
    expect(probes[at + 11]).toBe((source[16 + (rasterRow - 1) * 20] ?? 0) - 1);
    const exact = checkCanonicalReceiver(
      authored,
      primitive,
      pixel,
      Array.from(new Float32Array(sample.view)),
      sample.probes,
      p * SCREEN_PROBE_RECORD_BYTES,
    );
    ready.push({
      p,
      at,
      pixel,
      rasterRow,
      authored,
      primitive,
      exact,
      point: exact.map((v) => Number(v.n) / Number(v.d)),
    });
  }
  return { ready, records, source, frame };
}

function instanceIds(sample: Sample, submitted: ReturnType<typeof receiverRecords>) {
  const diagnostic = sample.diagnostic;
  assert(diagnostic);
  const raw = diagnostic.inputs.find((row) => row.binding === 2);
  assert(raw);
  const ids = wordsOf(raw.data),
    result = new Map<number, number>();
  const grid = diagnostic.inputs.find((row) => row.binding === 1);
  assert(grid);
  expect(Array.from(wordsOf(grid.data).subarray(12, 16))).toEqual(
    Array.from(submitted.frame.subarray(44, 48)),
  );
  for (let row = 1; row <= (submitted.source[2] ?? 0); row++) {
    if (submitted.records[(row - 1) * 16 + 10] === 0) continue;
    const range = resolveVisibleSurfaceRange({ records: submitted.records }, row).unwrap();
    assert(range);
    const canonical = (submitted.source[16 + (row - 1) * 20] ?? 0) - 1;
    if (canonical < 0) continue;
    const id = ids[canonical * 36 + 16];
    assert(id !== undefined);
    result.set(range.assetHandle, id);
  }
  return result;
}

function selectedRay(
  record: ReturnType<typeof receiverRecords>['ready'][number],
  direction: readonly number[],
) {
  if (exactNearBlocker(record.exact, direction) !== undefined) return 'near';
  const x = record.exact[0],
    y = record.exact[1];
  if (x && y && x.n > -x.d && x.n < x.d && y.n > -y.d && y.n < y.d && (direction[2] ?? NaN) < -0.8)
    return 'same-owner';
  return undefined;
}

function validateWorld(h: Harness, sample: Sample) {
  const submitted = receiverRecords(h, sample, 'canonical'),
    diag = sample.diagnostic;
  assert(diag);
  expect(diag.metadata.sourceSHA256).toBe(sha(screenProbeWorldWgsl('global-sdf')));
  expect(diag.metadata.extraDispatches).toBe(1);
  expect(diag.metadata.extraBindings).toBe(0);
  const ids = instanceIds(sample, submitted),
    before = new Uint32Array(sample.before),
    rays = new Uint32Array(sample.rays);
  const directions = new Float32Array(sample.before),
    observed = diag.bytes.slice().buffer;
  let nearBlocked = 0,
    otherPrimitiveBlocked = 0,
    litReceiverPixels = 0,
    boundaryUnavailable = 0;
  const facts: unknown[] = [];
  for (const record of submitted.ready) {
    if (record.authored !== h.authored[0] || record.exact[2]?.n !== 0n) continue;
    const pixel = (record.pixel >>> 16) * sample.image.width + (record.pixel & 65535);
    expect(sample.image.support?.[pixel] ?? NaN).toBeGreaterThan(0);
    if (sample.image.rgb.subarray(pixel * 3, pixel * 3 + 3).some((value) => value > 0))
      litReceiverPixels++;
    for (let r = 0; r < 64; r++) {
      const ray = record.p * 64 + r;
      if (status(before, ray) !== 1) continue;
      const direction = Array.from(directions.subarray(ray * 8, ray * 8 + 3)),
        kind = selectedRay(record, direction);
      if (kind === undefined) continue;
      const reference = exactCanonicalWorld(
        h.authored,
        record.exact,
        direction,
        { handle: record.authored.handle, primitive: record.primitive },
        100,
      );
      const first = reference.hits[0];
      assert(first);
      if (!first.interior) {
        boundaryUnavailable++;
        continue;
      }
      expect(first.handle).toBe(kind === 'near' ? h.authored[1]?.handle : record.authored.handle);
      const hit = decodeScreenWorldHit(observed, ray),
        instance = ids.get(first.handle);
      assert(instance !== undefined);
      const proof = checkScreenWorldHit(hit, reference, instance);
      expect(status(rays, ray)).toBe(0);
      // This compares the SAME legacy length quantity, not an independent t.
      expect(rays[ray * 8 + 7]).toBe(wordsOf(diag.bytes)[ray * 8 + 7]);
      const wrong = reference.hits.find((value) => value.t.n * first.t.d > first.t.n * value.t.d);
      const wrongPoint = wrong?.point ?? record.exact;
      expect(() =>
        checkScreenWorldHit(
          {
            ...hit,
            position: wrongPoint.map((value) => Math.fround(Number(value.n) / Number(value.d))),
          },
          reference,
          instance,
        ),
      ).toThrow();
      if (kind === 'near') nearBlocked++;
      else otherPrimitiveBlocked++;
      facts.push({
        probe: record.p,
        ray,
        kind,
        pixel: record.pixel,
        rasterRow: record.rasterRow,
        hit,
        proof,
      });
    }
  }
  return {
    scope:
      'Actual Renderer image plus frozen-query diagnostic re-dispatch; canonical construction only, rasterQualified remains 0',
    ready: submitted.ready.length,
    nearBlocked,
    otherPrimitiveBlocked,
    litReceiverPixels,
    boundaryUnavailable,
    facts,
  };
}

function checkWrongRevision(wrong: Sample) {
  const before = new Uint32Array(wrong.before),
    rays = new Uint32Array(wrong.rays);
  let rejected = 0;
  for (let ray = 0; ray < before.length / 8; ray++)
    if (status(before, ray) === 1) {
      expect(status(rays, ray)).toBe(4);
      rejected++;
    }
  expect(rejected).toBeGreaterThan(0);
  expect(
    Array.from(new Uint32Array(wrong.probes))
      .filter((_, i) => i % 24 === 20)
      .every((state) => state === 0),
  ).toBe(true);
}

function checkOldShortcut(h: Harness, sample: Sample) {
  const submitted = receiverRecords(h, sample, 'wrong-shortcut'),
    before = new Uint32Array(sample.before);
  expect(submitted.frame[9]).toBe(32);
  expect((submitted.frame[10] ?? 0) & 1).toBe(1);
  expect(submitted.frame.subarray(24, 40).some((word) => word !== 0)).toBe(true);
  const history = new Uint32Array(sample.previousScene);
  expect(history.some((word, i) => i % 2 === 1 && word >>> 16 !== 0)).toBe(true);
  let bypassed = 0;
  for (const record of submitted.ready) {
    if (record.authored !== h.authored[0] || record.exact[2]?.n !== 0n) continue;
    const directions = new Float32Array(sample.before);
    for (let r = 0; r < 64; r++) {
      const ray = record.p * 64 + r;
      if (
        exactNearBlocker(record.exact, Array.from(directions.subarray(ray * 8, ray * 8 + 3))) !==
          undefined &&
        status(before, ray) === 0
      )
        bypassed++;
    }
  }
  h.save('wrong-shortcut-proof.json', { validHistory: true, effectiveSteps: 32, bypassed });
  expect(
    bypassed,
    'The real old shortcut must be observed bypassing World, not a synthetic history mock',
  ).toBeGreaterThan(0);
}

it('constructs default software Screen receivers from their actual GBuffer primitives and keeps thin blockers', {
  timeout: 150_000,
}, async () => {
  const h = await screenCanonicalScene(manifest, 'screen-canonical-receiver');
  try {
    await h.settle(0);
    const sample = await h.receiverImage('canonical', true),
      gi = h.renderer.inspect().diffuseGi;
    h.save('canonical.png', rasterPng(sample.image.rgb, sample.image.width, sample.image.height));
    expect(h.renderer.inspect().profile.visibleSurface).toBe(true);
    assert(gi && 'gather' in gi && gi.gather === 'screen-probe' && gi.state === 'ready');
    expect(gi.field?.traversal).toBe('global-sdf');
    expect(gi.field?.traversalFallback).toBe('hardware-ray-query-disabled');
    expect(new Uint32Array(sample.frame)[9]).toBe(0);
    const proof = validateWorld(h, sample);
    h.save('canonical-proof.json', proof);
    expect(proof.nearBlocked).toBeGreaterThan(0);
    expect(proof.otherPrimitiveBlocked).toBeGreaterThan(0);
    expect(proof.litReceiverPixels).toBeGreaterThan(0);
    h.setWrongScreenShortcut(true);
    const shortcut = await h.receiverImage('wrong-shortcut');
    h.save(
      'wrong-shortcut.png',
      rasterPng(shortcut.image.rgb, shortcut.image.width, shortcut.image.height),
    );
    checkOldShortcut(h, shortcut);
    h.setWrongScreenShortcut(false);
    h.setWrongReceiverRevision(true);
    const wrong = await h.receiverImage('wrong-revision');
    checkWrongRevision(wrong);
    h.save('wrong-revision.png', rasterPng(wrong.image.rgb, wrong.image.width, wrong.image.height));
    expect(h.errors).toEqual([]);
  } catch (error) {
    h.save('failure.json', {
      error: String(error),
      inspection: h.renderer.inspect(),
      errors: h.errors,
    });
    throw error;
  } finally {
    await h.dispose();
  }
});
