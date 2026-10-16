import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildFrameModel, decodeTape, halfToFloat, openReplay } from '@forgeax/engine-rhi-debug';
import { bootstrapDawn } from '../../../shared/scripts/rhi-debug-verify.mjs';

// Read hit motion and receiver motion from the same canonical frame. Only the
// trace output is instrumented: retain its ray, coverage and confidence logic,
// but expose the selected source texel instead of radiance. This is neither a
// production render nor a calculation of reflected screen-space velocity.
const path = resolve(process.argv[2]);
const requestedReceiver = process.argv.find(arg => arg.startsWith('--receiver='))?.slice(11).split(',').map(Number);
if (requestedReceiver) assert.ok(requestedReceiver.length === 2 && requestedReceiver.every(value => Number.isInteger(value) && value >= 0));
const bytes = new Uint8Array(readFileSync(path));
const digest = value => createHash('sha256').update(value).digest('hex');
const tape = decodeTape(bytes).unwrap();
const model = buildFrameModel(tape);
const selected = entry => {
  const rows = model.works.filter(work => work.pipeline.shaders.some(shader => shader.entryPoint === entry));
  assert.equal(rows.length, 1, `Expected one ${entry} work`);
  return rows[0];
};
const trace = selected('ssr_trace');
const temporal = selected('ssr_temporal');
const binding = (work, slot) => {
  const row = work.bindings.find(binding => binding.groupIndex === 0 && binding.binding === slot);
  assert.ok(row?.resourceId);
  return row.resourceId;
};
assert.equal(binding(trace, 4), binding(temporal, 0));
const source = trace.pipeline.shaders.find(shader => shader.entryPoint === 'ssr_trace').source;
const entryStart = source.indexOf('fn ssr_trace(');
const entryEnd = source.indexOf('\n}\n', entryStart);
assert.ok(entryStart >= 0 && entryEnd > entryStart);
const entry = source.slice(entryStart, entryEnd);
const hitCalls = [...entry.matchAll(/let (\w+) = traceScreenRay\(/g)];
const sizes = [...entry.matchAll(/let (\w+) = textureDimensions\(sceneColor, 0i\);/g)];
const stores = [...entry.matchAll(/(textureStore\(traceOutput, vec2<i32>\(\w+\.xy\), vec4<f32>\()(\w+\.xyz), ([^\n]+)(\)\);)/g)];
assert.equal(hitCalls.length, 1, 'Unfamiliar captured trace call shape');
assert.equal(sizes.length, 1, 'Unfamiliar captured source dimensions');
assert.equal(stores.length, 1, 'Unfamiliar captured radiance output');
const coordinate = `min(vec2<u32>(${hitCalls[0][1]}.uv * vec2<f32>(${sizes[0][1]})), ${sizes[0][1]} - vec2(1u))`;
const instrumented = source.replace(stores[0][0], `${stores[0][1]}vec3<f32>(vec2<f32>(${coordinate}), 0f), ${stores[0][3]}${stores[0][4]}`);
assert.notEqual(instrumented, source);
const instrumentedShaderDigest = digest(instrumented);
const instrumentedShaderPath = resolve(dirname(path), `ssr-hit-coordinate-${instrumentedShaderDigest}.wgsl`);
writeFileSync(instrumentedShaderPath, instrumented);
const backend = await bootstrapDawn('SSR hit-motion inspection', tape);
const replay = (await openReplay(tape, {
  device: backend.freshDevice,
  createShaderModule: (device, descriptor) => backend.rhiWebgpu.createShaderModule(device,
    descriptor.code === source ? { ...descriptor, code: instrumented } : descriptor),
})).unwrap();
try {
  const read = async resourceId => {
    const row = (await replay.readResourceAtWork(resourceId, trace.workIndex)).unwrap();
    assert.equal(row.provenance.selectedWorkIndex, trace.workIndex);
    assert.equal(row.format, 'rgba16float');
    const data = new DataView(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength);
    return { ...row, values: Float32Array.from({ length: row.bytes.byteLength / 2 }, (_, index) => halfToFloat(data.getUint16(index * 2, true))) };
  };
  // Replay cursor mutations are strictly serial.
  const hits = await read(binding(trace, 4));
  const motion = await read(binding(temporal, 4));
  const normals = await read(binding(trace, 1));
  assert.ok(motion.width <= 2048 && motion.height <= 2048,
    'Integer hit coordinates must be exactly representable in the FP16 output');
  assert.equal(normals.width, motion.width);
  assert.equal(normals.height, motion.height);
  const pixel = (row, x, y) => [...row.values.slice((y * row.width + x) * 4, (y * row.width + x) * 4 + 4)];
  let requested;
  if (requestedReceiver) {
    const [x, y] = requestedReceiver;
    assert.ok(x < motion.width && y < motion.height);
    const hit = pixel(hits, Math.floor(x / 2), Math.floor(y / 2));
    requested = { receiverPixel: requestedReceiver, receiverTemporal: pixel(motion, x, y),
      hit, sourcePixel: hit[3] > 0 ? hit.slice(0, 2) : undefined,
      sourceTemporal: hit[3] > 0 ? pixel(motion, hit[0], hit[1]) : undefined };
  }
  const moving = tuple => Math.hypot(tuple[0], tuple[1]) > 1e-5;
  let validHits = 0, movingHits = 0, stationaryReceiversWithMovingHits = 0, reactiveHits = 0;
  const witnesses = [];
  for (let y = 0; y < hits.height; y++) for (let x = 0; x < hits.width; x++) {
    const hit = pixel(hits, x, y);
    if (hit[3] <= 0) continue;
    assert.ok(Number.isInteger(hit[0]) && Number.isInteger(hit[1]));
    assert.ok(hit[0] >= 0 && hit[0] < motion.width && hit[1] >= 0 && hit[1] < motion.height);
    const sourceMotion = pixel(motion, hit[0], hit[1]);
    const rx = Math.min(x * 2, motion.width - 1), ry = Math.min(y * 2, motion.height - 1);
    const receiverMotion = pixel(motion, rx, ry);
    if (sourceMotion[2] < 0 || receiverMotion[2] < 0) continue;
    validHits++;
    reactiveHits += Number(sourceMotion[3] > 0);
    if (!moving(sourceMotion)) continue;
    movingHits++;
    // Refuse a boundary whose current 3x3 temporal selector could already
    // pick a moving neighbor. The witness is genuinely stationary locally.
    const receiverNeighborhoodStatic = [-1, 0, 1].every(dy => [-1, 0, 1].every(dx => {
      const tuple = pixel(motion, Math.max(0, Math.min(motion.width - 1, rx + dx)), Math.max(0, Math.min(motion.height - 1, ry + dy)));
      return tuple[2] >= 0 && !moving(tuple) && tuple[3] === 0;
    }));
    if (!receiverNeighborhoodStatic) continue;
    stationaryReceiversWithMovingHits++;
    const witness = { receiver: [rx, ry], source: hit.slice(0, 2), confidence: hit[3],
      receiverMotion, sourceMotion, receiverNormalRoughness: pixel(normals, rx, ry),
      sourceMotionPixels: Math.hypot(sourceMotion[0] * motion.width, sourceMotion[1] * motion.height) };
    witnesses.push(witness);
    witnesses.sort((a, b) => b.sourceMotionPixels - a.sourceMotionPixels);
    witnesses.length = Math.min(witnesses.length, 12);
  }
  const result = { mode: 'instrumented-trace-replay', artifactDigest: digest(bytes), traceWorkIndex: trace.workIndex,
    temporalWorkIndex: temporal.workIndex, traceShaderDigest: digest(source), instrumentedShaderDigest, instrumentedShaderPath,
    motionResourceId: binding(temporal, 4), traceBindings: trace.bindings.map(row => ({ group: row.groupIndex, binding: row.binding, resourceId: row.resourceId })),
    dimensions: { width: motion.width, height: motion.height }, validHits, movingHits, stationaryReceiversWithMovingHits, reactiveHits, witnesses, requested,
    caveat: 'Selected source-texel motion, not projected reflected velocity or a temporal-quality verdict' };
  writeFileSync(resolve(dirname(path), 'ssr-hit-motion.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  replay.dispose();
}
process.exit(0);
