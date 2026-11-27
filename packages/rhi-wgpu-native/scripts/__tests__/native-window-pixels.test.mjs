import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeTriangleDraws, nativeTrianglePixels } from '../native-window-pixels.mjs';

const width = 32, height = 32, clear = [0.025, 0.055, 0.1];
const background = () => Float32Array.from({ length: width * height * 3 }, (_, i) => clear[i % 3]);
const foreground = () => {
  const rgb = background();
  const focal = 1 / Math.tan(Math.PI / 8);
  const top = height * (1 - Math.fround(0.7) * focal / 3) / 2;
  const bottom = height * (1 + Math.fround(0.6) * focal / 3) / 2;
  const halfWidth = width * Math.fround(0.7) * focal / (2 * 3 * 16 / 9);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const progress = (y + 0.5 - top) / (bottom - top);
    if (progress >= 0 && progress <= 1 && Math.abs(x + 0.5 - width / 2) <= progress * halfWidth)
      rgb.set([1, 1, 1], (y * width + x) * 3);
  }
  return rgb;
};

const gpuObservation = { status: 'unavailable', reason: 'unsupported-lane', draws: [] };
const geometryWork = () => ({
  kind: 'drawIndexedIndirect', vertexBuffers: [{ bufferHandleId: 'vertices' }],
  indexBuffer: { bufferHandleId: 'indices' },
  pipeline: { descriptor: { desc: { label: 'pbr-pipeline-forgeax::default-unlit' } },
    shaders: [{ stage: 'vertex', entryPoint: 'vs_main' }, { stage: 'fragment', entryPoint: 'fs_main' }] },
});

test('keeps complete material observations and permits the documented GPU gap only with same-frame scene raster work', () => {
  assert.equal(nativeTriangleDraws({ status: 'complete', draws: [{}] }).source, 'material-draw-observation');
  assert.equal(nativeTriangleDraws(gpuObservation, { works: [geometryWork()] }).source, 'same-frame-rhi');
  assert.equal(nativeTriangleDraws(gpuObservation).source, 'projected-triangle-pixels');
  assert.throws(() => nativeTriangleDraws({ status: 'complete', draws: [] }, { works: [geometryWork()] }), /empty/);
  assert.throws(() => nativeTriangleDraws({ ...gpuObservation, reason: 'superseded' }, { works: [geometryWork()] }), /documented/);
});

test('rejects absent geometry, fullscreen work, surface-only shaders and missing mesh bindings', () => {
  for (const modify of [
    work => { work.kind = 'draw'; },
    work => { work.pipeline.descriptor.desc.label = 'output-transform'; },
    work => { work.pipeline.shaders[1].entryPoint = 'fs_ao_input'; },
    work => { work.vertexBuffers = []; },
    work => { delete work.indexBuffer; },
  ]) {
    const work = geometryWork(); modify(work);
    assert.throws(() => nativeTriangleDraws(gpuObservation, { works: [work] }), /geometry draw/);
  }
  assert.throws(() => nativeTriangleDraws(gpuObservation, { works: [] }), /geometry draw/);
});

test('accepts a finite central foreground with unchanged background regions', () => {
  const result = nativeTrianglePixels(foreground(), width, height, clear);
  assert(result.coverage.interior > 0 && result.coverage.exterior > 0);
  assert.equal(result.coverage.mismatches, 0);
});

test('rejects a central rectangle, a displaced triangle and an inverted triangle', () => {
  const rectangle = background();
  for (let y = 10; y < 22; y++) for (let x = 10; x < 22; x++) rectangle.set([1, 1, 1], (y * width + x) * 3);
  const displaced = background(), inverted = background(), triangle = foreground();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
    if (x + 3 < width) displaced[(y * width + x + 3) * 3 + c] = triangle[(y * width + x) * 3 + c];
    inverted[((height - 1 - y) * width + x) * 3 + c] = triangle[(y * width + x) * 3 + c];
  }
  for (const rgb of [rectangle, displaced, inverted])
    assert.throws(() => nativeTrianglePixels(rgb, width, height, clear), /classification failed/);
});

test('rejects a projection with no pixels safely inside the two-pixel edge band', () => {
  const small = Float32Array.from({ length: 16 * 16 * 3 }, (_, i) => clear[i % 3]);
  for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) small.set([1, 1, 1], (y * 16 + x) * 3);
  assert.throws(() => nativeTrianglePixels(small, 16, 16, clear), /no effective classification/);
});
test('rejects the actual failure class: a completed clear-only frame', () => {
  assert.throws(() => nativeTrianglePixels(background(), width, height, clear), /Clear-only/);
});
test('rejects one bright pixel and a full-screen replacement', () => {
  const tiny = background();
  tiny.set([1, 1, 1], (16 * width + 16) * 3);
  assert.throws(() => nativeTrianglePixels(tiny, width, height, clear), /Clear-only/);
  assert.throws(() => nativeTrianglePixels(new Float32Array(width * height * 3).fill(1), width, height, clear), /Clear-only/);
});
test('rejects nonfinite output and corrupted background corners', () => {
  const invalid = foreground();
  invalid[0] = NaN;
  assert.throws(() => nativeTrianglePixels(invalid, width, height, clear), /finite/);
  const corner = foreground();
  for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) corner.set([1, 1, 1], (y * width + x) * 3);
  assert.throws(() => nativeTrianglePixels(corner, width, height, clear), /background/);
});
