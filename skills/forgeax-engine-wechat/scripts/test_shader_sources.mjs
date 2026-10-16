import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { exportSources, prepareFiles, prepareShaderSourcePlan, shaderSourceInstaller } from './shader_sources.mjs';

const identity = { file: 'fixture', bytes: 1, digest: 'sha256:' + '0'.repeat(64) };
const input = { version: 1, source: { alignment: identity, tape: identity, publication: identity }, operations: [
  { method: 'clear', args: [256], workIndex: null, pipelineId: null },
  { method: 'drawElementsInstanced', args: [4, 6, 5123, 0, 1], workIndex: 65, pipelineId: 'renderPipeline:810' },
  { method: 'clearBufferfv', args: [6144, 0, { values: [0.25, 0.5, 0.75, 1] }], workIndex: null, pipelineId: null },
  { method: 'drawArraysInstanced', args: [4, 0, 3, 1], workIndex: 72, pipelineId: 'renderPipeline:811' },
  { method: 'drawElementsInstanced', args: [4, 6, 5123, 0, 1], workIndex: 73, pipelineId: 'renderPipeline:810' },
] };
const official = value => JSON.stringify({ ok: true, tool: 'automation_evaluate', clientName: 'Codex', result: { success: true, result: value } }, null, 2);

function fixture(config = {}, prepared = prepareShaderSourcePlan(input)) {
  let time = 0, timerId = 0;
  const timers = new Map(), microtasks = [], calls = [], getters = [], native = { generation: 1, frameId: 0, deviceGeneration: 0 };
  const programHandles = prepared.programs.map(({ ordinal }) => ({ ordinal, shaders: [{ stage: 'vertex' }, { stage: 'fragment' }] }));
  const originals = {};
  for (const name of ['clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi', 'drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced', 'drawRangeElements', 'blitFramebuffer', 'useProgram', 'fenceSync']) originals[name] = function (...args) {
    calls.push({ name, receiver: this, args }); time += 0.25;
    if (name === config.throwMethod) throw config.sentinel;
    return name === 'fenceSync' ? config.nullFence ? null : { fence: true } : config.result;
  };
  const gl = Object.create(originals);
  const originalSource = shader => config.source ?? '#version 300 es\n// ' + shader.stage + '\nvoid main() { }\n';
  const translatedSource = shader => config.translated ?? '// Driver output: ' + shader.stage + '\n';
  let context;
  const inspect = name => {
    getters.push({ name, phase: context.__forgeaxShaderSourceProbe?.report().phase });
    assert.ok(['collecting', 'done'].includes(context.__forgeaxShaderSourceProbe?.report().phase), 'no getter before restored collection');
    for (const method of Object.keys(originals)) assert.equal(gl[method], originals[method], 'all methods restored before ' + name);
    time += config.getterDelay?.[name] ?? 0;
    if (config.throwGetter === name) throw Error('getter fixture failure');
  };
  gl.getAttachedShaders = handle => { inspect('getAttachedShaders'); return config.noShaders ? [] : handle.shaders; };
  gl.getShaderParameter = (shader, name) => { inspect('getShaderParameter'); assert.equal(name, 35663); return shader.stage === 'vertex' ? 35633 : 35632; };
  gl.getShaderSource = shader => { inspect('getShaderSource'); return config.nullSource ? null : originalSource(shader); };
  gl.getExtension = name => { inspect('getExtension'); assert.equal(name, 'WEBGL_debug_shaders'); return config.noTranslation ? null : { getTranslatedShaderSource(shader) { inspect('getTranslatedShaderSource'); return translatedSource(shader); } }; };
  for (const name of ['getParameter', 'getQuery', 'createQuery', 'beginQuery', 'endQuery', 'getQueryParameter']) gl[name] = () => { throw Error('forbidden ' + name); };
  if (config.installFails) Object.defineProperty(gl, 'clearBufferiv', { get() { return originals.clearBufferiv; }, configurable: false });
  const canvas = { getContext(kind) { assert.equal(kind, 'webgl2'); return gl; } };
  context = vm.createContext({ performance: { now: () => time }, setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: time + delay, callback }); return id; }, clearTimeout(id) { timers.delete(id); }, queueMicrotask(callback) { microtasks.push(callback); } });
  const readReceipt = () => ({ generation: native.generation, frame: { frameId: native.frameId, deviceGeneration: native.deviceGeneration } });
  const install = () => vm.runInContext(shaderSourceInstaller(), context)({ canvas, plan: prepared, readReceipt });
  function tick(ms = 0) {
    const end = time + ms; let count = 0;
    while (true) {
      while (microtasks.length) microtasks.shift()();
      const ready = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!ready) break;
      assert.ok(++count < 10000); timers.delete(ready[0]); time = Math.max(time, ready[1].at); ready[1].callback();
    }
    time = Math.max(end, time);
  }
  const argsFor = operation => operation.args.map(value => typeof value === 'number' ? value : vm.runInContext('new Float32Array(' + JSON.stringify(value.values) + ')', context));
  function frame({ fence = true, switchPrograms = true } = {}) {
    for (const operation of prepared.operations) {
      if (operation.programOrdinal !== null && switchPrograms) gl.useProgram(programHandles[operation.programOrdinal - 1]);
      gl[operation.method](...argsFor(operation));
    }
    if (fence) { native.frameId++; gl.fenceSync(9117, 0); }
  }
  const api = () => context.__forgeaxShaderSourceProbe;
  const restored = () => { for (const method of Object.keys(originals)) assert.equal(gl[method], originals[method]); assert.equal(api().report().methodsRestored, true); };
  const align = () => { gl.fenceSync(9117, 0); };
  return { config, gl, originals, context, native, calls, getters, programHandles, prepared, timers, install, tick, frame, api, align, restored, argsFor, originalSource, translatedSource };
}

test('source plan derives existing work indices and first-draw program ordinals, and rejects ambiguous inputs', () => {
  const plan = prepareShaderSourcePlan(input, [2]);
  assert.deepEqual(plan.programs, [
    { ordinal: 1, pipelineId: 'renderPipeline:810', workIndices: [65, 73], glEventIndices: [1, 4] },
    { ordinal: 2, pipelineId: 'renderPipeline:811', workIndices: [72], glEventIndices: [3] },
  ]);
  assert.deepEqual(plan.selectedPrograms, [2]);
  for (const change of [p => { p.operations[0].args = [1280]; }, p => { p.operations[4].workIndex = 65; }, p => { p.operations[1].pipelineId = null; }, p => { p.operations[2].args[2].values.push(NaN); }, p => { p.source.tape.digest = 'bad'; }]) {
    const invalid = structuredClone(input); change(invalid); assert.throws(() => prepareShaderSourcePlan(invalid));
  }
  assert.throws(() => prepareShaderSourcePlan(input, [3]));
});

test('one natural frame is forwarded exactly; getters run only after its fence and full restoration', () => {
  const f = fixture(); f.install(); f.align(); f.gl.blitFramebuffer(0, 1170, 2532, 0, 0, 0, 2532, 1170, 16384, 9728);
  const before = f.calls.length; f.frame(); assert.equal(f.getters.length, 0); f.restored();
  assert.equal(f.api().report().phase, 'restored');
  assert.equal(f.calls.slice(before).filter(call => call.name.startsWith('draw')).length, 3);
  f.tick(); const report = f.api().report();
  assert.equal(report.status, 'complete'); assert.equal(report.observedOperations, 5); assert.equal(report.observedDraws, 3);
  assert.equal(report.retainedProgramHandles, 0); assert.ok(report.sourcesStartedAtMs >= report.restoredAtMs);
  assert.deepEqual(JSON.parse(JSON.stringify(f.api().readDraws().rows)), [
    { glEventIndex: 1, workIndex: 65, programOrdinal: 1 }, { glEventIndex: 3, workIndex: 72, programOrdinal: 2 }, { glEventIndex: 4, workIndex: 73, programOrdinal: 1 },
  ]);
  for (const program of [1, 2]) for (const stage of ['vertex', 'fragment']) {
    assert.equal(f.api().readSource(program, stage, 'original').text, f.originalSource({ stage }));
    assert.equal(f.api().readSource(program, stage, 'translated').text, f.translatedSource({ stage }));
  }
  assert.equal(f.timers.size, 0); f.api().release(); assert.equal(f.context.__forgeaxShaderSourceProbe, undefined);
});

test('HAL submission and completion fences before the next clear do not invent a captured frame', () => {
  // Live ground capture failed with 70 useProgram calls, zero captured operations,
  // then frame-structure-mismatch. HAL submit signals a fence, and the independent
  // createWebGLCompletion entry can synchronously add another before the next draw.
  const f = fixture(); f.install(); f.frame({ fence: false });
  for (let i = 3; i < 70; i++) f.gl.useProgram(f.programHandles[i % 2]);
  f.native.frameId++;
  f.gl.fenceSync(9117, 0); // HAL signal: finish alignment only.
  assert.equal(f.api().report().phase, 'waiting');
  assert.equal(f.api().report().useProgramCalls, 70);
  assert.equal(f.api().report().observedOperations, 0);
  const completionFence = f.gl.fenceSync(9117, 0); // Queue completion: no clear yet.
  assert.deepEqual(completionFence, { fence: true });
  assert.equal(f.api().report().phase, 'waiting');
  assert.equal(f.api().report().observedOperations, 0);
  assert.equal(f.getters.length, 0);
  assert.equal(f.api().report().prefixFences, 1);
  assert.ok(f.api().report().alignedAtMs >= f.api().report().installedAtMs);
  f.gl.blitFramebuffer(0, 1170, 2532, 0, 0, 0, 2532, 1170, 16384, 9728);
  f.frame(); f.restored();
  f.gl.fenceSync(9117, 0); // Matching frame's later completion fence is untouched.
  assert.equal(f.getters.length, 0); f.tick();
  assert.equal(f.api().report().status, 'complete');
  assert.equal(f.api().report().observedOperations, f.prepared.operations.length);
  assert.equal(f.api().report().observedDraws, 3);
});

test('prefix fences without a first clear stay bounded and cannot qualify a frame', () => {
  const f = fixture(); f.install(); f.align();
  for (let i = 0; i < 129; i++) f.gl.fenceSync(9117, 0);
  assert.equal(f.api().report().stopReason, 'prefix-fence-limit'); assert.equal(f.api().report().observedOperations, 0); assert.equal(f.getters.length, 0); f.restored();
  const g = fixture(); g.install(); g.align(); g.gl.fenceSync(9117, 0); g.tick(30000);
  assert.equal(g.api().report().status, 'timeout'); assert.equal(g.getters.length, 0); g.restored();
});

test('selected program sources retain full text through official-envelope-safe pages, including quotes and Unicode', () => {
  const text = ('// \u6c49\u5b57\u{1f600}\\\"\n' + '\u0000').repeat(9000);
  const f = fixture({ source: text, translated: text }, prepareShaderSourcePlan(input, [2])); f.install(); f.align(); f.frame(); f.tick();
  assert.equal(f.api().report().status, 'complete'); assert.equal(f.api().program(1).availability, 'not-collected');
  assert.equal(f.getters.filter(row => row.name === 'getAttachedShaders').length, 1);
  for (const stage of ['vertex', 'fragment']) for (const kind of ['original', 'translated']) {
    let result = '', offset = 0, size = 4096;
    while (offset < text.length) {
      const page = f.api().readSource(2, stage, kind, offset, size);
      if (page.status === 'page-too-large') { assert.ok(page.retryCount < size); size = page.retryCount; continue; }
      assert.ok(Buffer.byteLength(official(page)) < 32768);
      const received = JSON.parse(Buffer.from(official(page)).subarray(0, 65536).toString()).result.result;
      const first = received.text.charCodeAt(0), last = received.text.charCodeAt(received.text.length - 1);
      assert.ok(!(first >= 0xdc00 && first <= 0xdfff) && !(last >= 0xd800 && last <= 0xdbff), 'a page must not split a Unicode scalar across host JSON calls');
      assert.equal(received.offset, offset); result += received.text; offset = received.nextOffset;
    }
    assert.equal(result, text); assert.equal(Buffer.byteLength(result), f.api().program(2).shaders.find(s => s.stage === stage)[kind].utf8Bytes);
  }
  assert.ok(Buffer.byteLength(official(f.api().report())) < 32768);
});

test('tiny source pages never split surrogate pairs or accept an offset inside one', () => {
  const f = fixture({ source: 'x😀y' }); f.install(); f.align(); f.frame(); f.tick();
  assert.equal(f.api().readSource(1, 'vertex', 'original', 0, 2).text, 'x');
  assert.equal(f.api().readSource(1, 'vertex', 'original', 1, 1).status, 'page-too-small');
  assert.equal(f.api().readSource(1, 'vertex', 'original', 1, 2).text, '😀');
  assert.equal(f.api().readSource(1, 'vertex', 'original', 2, 2).status, 'invalid-page');
});

test('translation absence or driver failure stays distinct from original GLSL; missing originals are partial', () => {
  for (const config of [{ noTranslation: true }, { throwGetter: 'getTranslatedShaderSource' }, { throwGetter: 'getExtension' }]) {
    const f = fixture(config); f.install(); f.align(); f.frame(); f.tick(); assert.equal(f.api().report().status, 'complete');
    assert.equal(f.api().program(1).shaders[0].original.availability, 'available');
    assert.notEqual(f.api().program(1).shaders[0].translated.availability, 'available');
    assert.equal(f.api().readSource(1, 'vertex', 'translated').status, 'source-unavailable');
  }
  for (const config of [{ nullSource: true }, { noShaders: true }, { throwGetter: 'getShaderSource' }]) {
    const f = fixture(config); f.install(); f.align(); f.frame(); f.tick(); assert.equal(f.api().report().status, 'partial'); f.restored();
  }
});

test('argument drift, unknown programs, pipeline aliasing, extra operations and early fences abort without getters', () => {
  for (const mode of ['drift', 'missing-use', 'alias', 'extra', 'early-fence']) {
    const f = fixture(); f.install(); f.align(); f.gl.clear(256);
    if (mode === 'drift') f.gl.drawElementsInstanced(4, 6, 5123, 4, 1);
    else if (mode === 'missing-use') f.gl.drawElementsInstanced(4, 6, 5123, 0, 1);
    else if (mode === 'extra') f.gl.blitFramebuffer(0, 0, 1, 1, 0, 0, 1, 1, 16384, 9728);
    else if (mode === 'early-fence') f.gl.fenceSync(9117, 0);
    else {
      f.gl.useProgram(f.programHandles[0]); f.gl.drawElementsInstanced(4, 6, 5123, 0, 1);
      f.gl.clearBufferfv(6144, 0, new Float32Array([0.25, 0.5, 0.75, 1])); f.gl.drawArraysInstanced(4, 0, 3, 1);
    }
    assert.equal(f.api().report().status, 'aborted', mode); assert.equal(f.getters.length, 0); assert.equal(f.api().report().retainedProgramHandles, 0); f.restored();
    if (mode === 'early-fence') { assert.equal(f.api().report().mismatch.kind, 'frame-fence'); assert.equal(f.api().report().mismatch.observedOperations, 1); }
  }
});

test('original receiver, arguments, return values and exception identity survive observation', () => {
  const token = {}, f = fixture({ result: token }); f.install(); f.align();
  const receiver = {}, values = new Float32Array(4);
  assert.equal(f.gl.clearBufferfv.call(receiver, 6144, 0, values), token); assert.equal(f.calls.at(-1).receiver, receiver); assert.equal(f.calls.at(-1).args[2], values);
  assert.equal(f.gl.useProgram(f.programHandles[0]), token);
  f.config.throwMethod = 'clear'; f.config.sentinel = token;
  assert.throws(() => f.gl.clear(256), error => error === token); f.restored();
  const g = fixture(); g.install(); g.align(); g.config.throwMethod = 'fenceSync'; g.config.sentinel = token;
  assert.throws(() => g.gl.fenceSync(9117, 0), error => error === token); g.restored();
});

test('deadline, cancellation, install failure and generation replacement release handles and restore methods', () => {
  const f = fixture(); f.install(); f.tick(30000); assert.equal(f.api().report().status, 'timeout'); f.restored();
  const g = fixture({ installFails: true }); assert.equal(g.install().status, 'aborted'); g.restored();
  const h = fixture(); h.install(); h.align(); h.frame(); h.native.deviceGeneration++; h.tick(); assert.equal(h.api().report().stopReason, 'receipt-generation-changed'); assert.equal(h.getters.length, 0); h.restored();
  const j = fixture(); j.install(); j.align(); j.frame(); j.api().cancel(); j.tick(); assert.equal(j.api().report().status, 'cancelled'); assert.equal(j.getters.length, 0); j.restored();
  for (const x of [f, g, h, j]) assert.equal(x.api().report().retainedProgramHandles, 0);
});

test('external wrapper owners are preserved and failed restoration prevents source getters', () => {
  const f = fixture(); f.install(); const replacement = () => {}; f.gl.clear = replacement; f.tick(10);
  assert.equal(f.api().report().status, 'restore-failed'); assert.equal(f.gl.clear, replacement); assert.equal(f.getters.length, 0);
  const g = fixture(); g.install(); g.align(); Object.defineProperty(g.gl, 'useProgram', { value: g.gl.useProgram, configurable: false }); g.frame(); g.tick();
  assert.equal(g.api().report().status, 'restore-failed'); assert.equal(g.getters.length, 0);
});

test('oversized sources terminate explicitly rather than returning silently truncated bodies', () => {
  const f = fixture({ source: 'x'.repeat(2 * 1024 * 1024 + 1) }); f.install(); f.align(); f.frame(); f.tick();
  assert.equal(f.api().report().stopReason, 'source-byte-limit'); assert.equal(f.api().report().status, 'aborted'); assert.equal(f.api().report().retainedProgramHandles, 0); f.restored();
});

test('a synchronous getter crossing the deadline prevents subsequent source reads', () => {
  const f = fixture({ getterDelay: { getShaderSource: 30001 } }); f.install(); f.align(); f.frame(); f.tick();
  assert.equal(f.api().report().status, 'timeout'); assert.equal(f.api().report().retainedProgramHandles, 0);
  assert.equal(f.getters.filter(row => row.name === 'getShaderSource').length, 1);
  assert.equal(f.getters.filter(row => row.name === 'getTranslatedShaderSource').length, 0); f.restored();
});

test('preparation records the original plan bytes, emits a standalone installer and does not overwrite evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forgeax-shader-sources-'));
  try {
    const planPath = join(dir, 'plan.json'), out = join(dir, 'prepared'); await writeFile(planPath, JSON.stringify(input));
    const result = await prepareFiles({ planPath, programs: [1, 2], out }); assert.equal(result.status, 'prepared');
    assert.equal(typeof vm.runInNewContext(await readFile(join(out, 'install.js'), 'utf8')), 'function');
    const prepared = JSON.parse(await readFile(join(out, 'plan.json'), 'utf8')); assert.equal(prepared.source.preparedPlan.bytes, Buffer.byteLength(JSON.stringify(input)));
    assert.ok(!JSON.stringify(prepared).includes(dir));
    await assert.rejects(prepareFiles({ planPath, out }), /EEXIST/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('export writes exact original and translated bodies with digests and rejects incomplete transfers before writing', async () => {
  const f = fixture(); f.install(); f.align(); f.frame(); f.tick();
  const collected = { report: f.api().report(), programs: [f.api().program(1), f.api().program(2)], draws: f.api().readDraws().rows, sources: [] };
  for (const ordinal of [1, 2]) for (const stage of ['vertex', 'fragment']) for (const kind of ['original', 'translated']) collected.sources.push({ ordinal, stage, kind, text: f.api().readSource(ordinal, stage, kind).text });
  const dir = await mkdtemp(join(tmpdir(), 'forgeax-shader-export-'));
  try {
    const out = join(dir, 'exported'); assert.equal((await exportSources(collected, out)).files, 8);
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    for (const file of manifest.files) {
      const bytes = await readFile(join(out, file.file)); assert.equal(file.digest, 'sha256:' + createHash('sha256').update(bytes).digest('hex'));
      assert.equal(bytes.toString(), collected.sources.find(body => body.ordinal === file.ordinal && body.stage === file.stage && body.kind === file.kind).text);
    }
    await assert.rejects(exportSources(collected, out), /EEXIST/);
    for (const alter of [value => { value.sources.pop(); }, value => { value.sources[0].text += 'changed'; }, value => { value.draws[0].programOrdinal = 2; }, value => { value.report.methodsRestored = false; }]) {
      const invalid = structuredClone(collected); alter(invalid); await assert.rejects(exportSources(invalid, join(dir, 'invalid')));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

if (process.env.FORGEAX_SHADER_SOURCE_PLAN) test('the real prepared 88-operation/14-program plan matches the same natural-frame path', async () => {
  const plan = prepareShaderSourcePlan(JSON.parse(await readFile(process.env.FORGEAX_SHADER_SOURCE_PLAN, 'utf8')));
  const f = fixture({}, plan); f.install(); f.frame(); f.gl.fenceSync(9117, 0); f.frame(); f.gl.fenceSync(9117, 0); f.tick();
  const report = f.api().report(); assert.equal(report.status, 'complete'); assert.equal(report.observedOperations, plan.operations.length); assert.equal(report.collectedPrograms, plan.selectedPrograms.length);
  assert.ok(Buffer.byteLength(official(report)) < 32768);
  for (const ordinal of plan.selectedPrograms) assert.ok(Buffer.byteLength(official(f.api().program(ordinal))) < 32768);
});
