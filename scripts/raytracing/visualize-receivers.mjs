#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import UPNG from 'upng-js';
import { buildFrameModel, decodeTape } from '../../packages/rhi-debug/dist/index.mjs';

const [directory, widthArg, heightArg] = process.argv.slice(2);
const width = Number(widthArg),
  height = Number(heightArg),
  count = width * height;
assert(
  directory &&
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    count <= 262144,
  'usage: node scripts/raytracing/visualize-receivers.mjs <evidence-directory> <width> <height>',
);
const bytes = await readFile(join(directory, 'raster-source-live.bin'));
const transport = await readFile(join(directory, 'raster-source-transport.bin'));
assert.equal(transport.byteLength, bytes.byteLength);
const accumulation = new DataView(transport.buffer, transport.byteOffset, transport.byteLength);
const capture = await readFile(join(directory, 'raster-source-bytes.rhitape'));
assert.equal(bytes.byteLength, count * 80, 'expected tightly packed 80-byte PathState rows');
const model = buildFrameModel(decodeTape(capture).unwrap());
const producer = model.works.find((w) =>
  w.pipeline.shaders.some((s) => s.entryPoint === 'generateRasterRays'),
);
assert(producer, 'capture must contain the receiver producer');
assert.equal(producer.bindings.find((b) => b.binding === 6)?.bufferSize, bytes.byteLength);
const raw = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const palette = [
  { name: 'background', rgb: [24, 24, 24] },
  { name: 'active', rgb: [46, 204, 113] },
  { name: 'hemisphere-null', rgb: [52, 152, 219] },
  { name: 'invalid-row-or-primitive', rgb: [255, 0, 255] },
  { name: 'invalid-depth-or-position', rgb: [255, 85, 0] },
  { name: 'invalid-flags', rgb: [255, 207, 0] },
  { name: 'extent-mismatch', rgb: [255, 255, 255] },
];
const scale = Math.max(1, Math.floor(512 / Math.max(width, height)));
const panelWidth = width * scale,
  panelHeight = height * scale,
  gap = 8;
const imageHeight = panelHeight * 3 + gap * 2;
const rgba = new Uint8Array(panelWidth * imageHeight * 4);
const reasons = Array(palette.length).fill(0),
  selected = [];
let maxUnitError = 0;
for (let i = 0; i < count; i++) {
  const diagnostic = raw.getUint32(i * 80 + 76, true);
  const active = raw.getUint32(i * 80 + 64, true);
  const invalid = raw.getFloat32(i * 80 + 60, true);
  assert(palette[diagnostic], `unknown producer diagnostic at pixel ${i}`);
  assert(active === 0 || active === 1);
  assert.equal(invalid, diagnostic >= 3 ? 1 : 0);
  assert.equal(active, diagnostic === 1 ? 1 : 0);
  const floats = (offset, n) =>
    Array.from({ length: n }, (_, c) => raw.getFloat32(i * 80 + offset + c * 4, true));
  const origin = floats(0, 3),
    direction = floats(16, 3),
    throughput = floats(32, 3);
  assert([...origin, ...direction, ...throughput].every(Number.isFinite), `nonfinite pixel ${i}`);
  if (active) maxUnitError = Math.max(maxUnitError, Math.abs(Math.hypot(...direction) - 1));
  reasons[diagnostic]++;
  if (selected.length < 32)
    selected.push({
      pixel: i,
      diagnostic: palette[diagnostic].name,
      active,
      invalid,
      origin,
      direction,
      throughput,
      coneWidth: raw.getFloat32(i * 80 + 12, true),
      transport: {
        radiance: [0, 4, 8].map((offset) => accumulation.getFloat32(i * 80 + offset, true)),
        acceptedSamples: accumulation.getUint32(i * 80 + 12, true),
        rejectedSamples: accumulation.getUint32(i * 80 + 28, true),
      },
    });
  const colors = [
    palette[diagnostic].rgb,
    diagnostic === 1 || diagnostic === 2
      ? direction.map((v) => Math.round((v * 0.5 + 0.5) * 255))
      : [0, 0, 0],
    throughput.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)),
  ];
  for (let panel = 0; panel < 3; panel++)
    for (let y = 0; y < scale; y++)
      for (let x = 0; x < scale; x++) {
        const dest =
          ((Math.floor(i / width) * scale + y + panel * (panelHeight + gap)) * panelWidth +
            (i % width) * scale +
            x) *
          4;
        rgba.set([...colors[panel], 255], dest);
      }
}
assert(maxUnitError < 1e-5, `nonunit receiver direction: ${maxUnitError}`);
await writeFile(
  join(directory, 'receivers.png'),
  new Uint8Array(UPNG.encode([rgba.buffer], panelWidth, imageHeight, 0)),
);
const digest = (b) => createHash('sha256').update(b).digest('hex');
await writeFile(
  join(directory, 'receivers.json'),
  `${JSON.stringify(
    {
      scope: 'GPU unit-receiver D diagnostic; not a beauty image or ordinary Renderer GI',
      width,
      height,
      scale,
      panels: ['reason', 'direction xyz mapped from [-1,1]', 'unit-receiver throughput RGB [0,1]'],
      palette,
      reasons,
      maxUnitError,
      selected,
      provenance: {
        tape: { bytes: capture.length, sha256: digest(capture) },
        raw: { bytes: bytes.length, sha256: digest(bytes) },
        transport: { bytes: transport.length, sha256: digest(transport) },
        workIndex: producer.workIndex,
        bindings: producer.bindings,
      },
      works: model.works.map((w) => ({
        workIndex: w.workIndex,
        kind: w.kind,
        entryPoints: w.pipeline.shaders.map((s) => s.entryPoint),
        bindings: w.bindings,
      })),
    },
    null,
    2,
  )}\n`,
);
