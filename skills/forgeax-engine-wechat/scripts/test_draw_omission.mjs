import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { installDrawOmissionProbe, prepareDrawOmissionPlan, prepareFiles } from './draw_omission.mjs';

const identity = { file: 'fixture', bytes: 1, digest: 'sha256:' + '0'.repeat(64) };
const source = { alignment: identity, tape: identity, publication: identity };
const alignment = {
  success: true, programMappingOneToOne: true, failures: [], matchedDraws: 3, glEvents: 5,
  draws: [
    { glEventId: 1, rhiWorkIndex: 12, glMethod: 'drawElementsInstanced', glArgs: [4, 3, 5125, 12, 1], pipelineId: 'renderPipeline:2', drawRequestMatches: true },
    { glEventId: 3, rhiWorkIndex: 13, glMethod: 'drawArraysInstanced', glArgs: [4, 0, 3, 1], pipelineId: 'renderPipeline:3', drawRequestMatches: true },
    { glEventId: 4, rhiWorkIndex: 14, glMethod: 'drawElements', glArgs: [4, 6, 5123, 0], pipelineId: 'renderPipeline:4', drawRequestMatches: true },
  ],
  clears: [{ glEventId: 0, method: 'clear', args: [256] }, { glEventId: 2, method: 'clearBufferfv', args: [6144, 0, { type: 'Float32Array', length: 4, first: [0.25, 0.5, 0.75, 1] }] }],
};
const defaultGroups = [{ name: 'control', workIndices: [] }, { name: 'omit-pipeline', workIndices: [12, 14] }];
const makePlan = groups => prepareDrawOmissionPlan(structuredClone(alignment), groups ?? defaultGroups, source);

function fixture(plan = makePlan(), config = {}) {
  let time = 0, timerId = 0;
  const timers = new Map(), microtasks = [], calls = [], native = { generation: 1, deviceGeneration: 0, frameId: 0, completed: 0 };
  const originalMethods = {};
  for (const name of ['clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi', 'drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced', 'drawRangeElements', 'blitFramebuffer', 'fenceSync']) {
    originalMethods[name] = function (...args) {
      calls.push({ name, receiver: this, args }); time += 0.25;
      if (config.throwMethod === name) throw config.sentinel;
      return name === 'fenceSync' ? { nativeSync: true } : config.results?.[name];
    };
  }
  const gl = Object.create(originalMethods);
  for (const name of ['getParameter', 'getQuery', 'getQueryParameter', 'getExtension', 'createQuery', 'beginQuery', 'endQuery', 'getAttachedShaders']) gl[name] = () => { throw Error(`forbidden ${name}`); };
  if (config.installFails) Object.defineProperty(gl, 'clearBufferiv', { get() { return originalMethods.clearBufferiv; }, configurable: false });
  const canvas = { id: 'a-caller-owned-canvas', getContext(kind) { assert.equal(kind, 'webgl2'); return gl; } };
  const context = vm.createContext({ performance: { now: () => time + (config.clockFraction ?? 0) }, setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: time + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); }, queueMicrotask(callback) { microtasks.push(callback); } });
  const readReceipt = () => ({ ...native, phase: 'ready', presented: native.completed,
    lastCompletion: { frameId: native.completed, deviceGeneration: native.deviceGeneration, presentation: 'ready' },
    frame: { frameId: native.frameId, deviceGeneration: native.deviceGeneration, pendingCompletionCount: Math.max(0, native.frameId - native.completed) } });
  const install = () => vm.runInContext('(' + installDrawOmissionProbe.toString() + ')', context)({ canvas, plan, readReceipt });
  function tick(ms = 0) {
    const end = time + ms; let ticks = 0;
    while (true) {
      while (microtasks.length) microtasks.shift()();
      const ready = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!ready) break; assert.ok(++ticks < 10000);
      timers.delete(ready[0]); time = Math.max(time, ready[1].at); ready[1].callback();
    }
    time = Math.max(time, end);
  }
  const argsFor = operation => operation.args.map(value => typeof value === 'number' ? value : vm.runInContext(`new Float32Array(${JSON.stringify(value.values)})`, context));
  function frame() {
    for (const operation of plan.operations) gl[operation.method](...argsFor(operation));
    native.frameId++; native.completed = Math.max(0, native.frameId - 2); gl.fenceSync(9117, 0); tick(20);
  }
  const api = () => context.__forgeaxDrawOmissionProbe;
  function report() {
    const value = api().report();
    for (const [collection, count] of Object.entries(value.collections ?? {})) {
      const rows = []; let offset = 0, size = 4;
      while (offset < count) {
        const page = api().read(collection, offset, size);
        if (page.status === 'page-too-large') { size = page.retryCount; continue; }
        rows.push(...page.rows); offset = page.nextOffset;
      }
      value[collection] = rows;
    }
    return value;
  }
  function restored() { for (const name of ['clear', 'drawElementsInstanced', 'fenceSync']) assert.equal(gl[name], originalMethods[name]); assert.equal(api().report().methodsRestored, true); }
  return { gl, canvas, context, calls, native, install, tick, frame, api, report, restored, config, plan, argsFor };
}

test('plan derives selections from matched work indices and rejects incomplete/ambiguous evidence', () => {
  const p = makePlan(); assert.deepEqual(p.operations.map(x => x.workIndex), [null, 12, null, 13, 14]); assert.deepEqual(p.operations[2].args[2], { values: [0.25, 0.5, 0.75, 1] });
  for (const change of [a => { a.success = false; }, a => { a.draws[0].drawRequestMatches = false; }, a => { a.draws[1].rhiWorkIndex = 12; }, a => { a.draws[1].glEventId = 1; }, a => { a.glEvents = 6; }, a => { a.clears[1].args[2].length = 8; }]) {
    const a = structuredClone(alignment); change(a); assert.throws(() => prepareDrawOmissionPlan(a, defaultGroups, source));
  }
  assert.throws(() => makePlan([{ name: 'control', workIndices: [] }, { name: 'unknown', workIndices: [99] }]));
  assert.throws(() => makePlan([{ name: 'bad-control', workIndices: [12] }, { name: 'other', workIndices: [] }]));
});

test('complete method/argument matching supports cross-realm typed arrays and preserves all nonselected calls', () => {
  const f = fixture(); f.install(); f.frame();
  for (let frame = 0; frame < 10; frame++) {
    const first = f.calls.length; f.gl.blitFramebuffer(0, 1, 2, 0, 0, 0, 2, 1, 16384, 9728); f.frame();
    const draws = f.calls.slice(first).filter(call => call.name.startsWith('draw'));
    assert.deepEqual(draws.map(call => call.name), frame < 5 ? ['drawElementsInstanced', 'drawArraysInstanced', 'drawElements'] : ['drawArraysInstanced']);
    assert.equal(f.calls.slice(first).filter(call => call.name.startsWith('clear')).length, 2);
  }
  f.restored(); assert.equal(f.report().phase, 'restored');
  f.frame(); f.frame(); assert.equal(f.report().phase, 'restored'); f.frame();
  const report = f.report(); assert.equal(report.status, 'complete'); assert.equal(report.samples.length, 10);
  assert.ok(report.samples.every(s => s.structureMatch && s.events === 5 && s.observedDraws === 3));
  assert.ok(report.restoredReadyReceipt.lastCompletion.frameId > report.samples[9].frameId); assert.ok(Buffer.byteLength(JSON.stringify(report)) < 60000);
  f.api().release(); assert.equal(f.context.__forgeaxDrawOmissionProbe, undefined);
});

test('argument drift and in-frame extra operations abort before skipping an unverified call', () => {
  for (const drift of ['index-offset', 'clear-value', 'method', 'extra']) {
    const f = fixture(); f.install(); f.frame(); f.gl.clear(256);
    if (drift === 'index-offset') f.gl.drawElementsInstanced(4, 3, 5125, 16, 1);
    else if (drift === 'method') f.gl.drawArrays(4, 0, 3);
    else if (drift === 'extra') f.gl.blitFramebuffer(0, 0, 1, 1, 0, 0, 1, 1, 16384, 9728);
    else { f.gl.drawElementsInstanced(4, 3, 5125, 12, 1); f.gl.clearBufferfv(6144, 0, new Float32Array([0.25, 0.5, 0.25, 1])); }
    assert.equal(f.report().stopReason, 'operation-mismatch'); assert.ok(f.report().mismatch.actual); f.restored();
  }
});

test('only prefix blits are excluded; idle time is not submission time and unexpected first methods abort', () => {
  const f = fixture(); f.install(); f.frame(); f.gl.blitFramebuffer(0, 0, 1, 1, 0, 0, 1, 1, 16384, 9728); f.tick(900); f.frame();
  assert.equal(f.report().samples[0].submitWallMs, 1.25); assert.equal(f.report().prefixSkippedCount, 1); f.api().cancel();
  const g = fixture(); g.install(); g.frame(); g.gl.clear(1280); assert.equal(g.report().stopReason, 'first-operation-mismatch'); g.restored();
});

test('borrowed receiver, argument identity, return value and original exception identity survive wrappers', () => {
  const returned = {}, f = fixture(makePlan(), { results: { clearBufferfv: returned } }); f.install(); f.frame();
  const receiver = {}, values = new Float32Array(4); assert.equal(f.gl.clearBufferfv.call(receiver, 6144, 0, values), returned); assert.equal(f.calls.at(-1).receiver, receiver); assert.equal(f.calls.at(-1).args[2], values);
  const sentinel = {}; f.config.throwMethod = 'clear'; f.config.sentinel = sentinel;
  assert.throws(() => f.gl.clear(256), error => error === sentinel); f.restored();
});

test('coalesced observations retain raw skipped frame IDs without inventing completion times', () => {
  const f = fixture(); f.install(); f.frame(); f.frame(); f.frame(); f.frame(); f.native.completed = f.native.frameId; f.tick(10);
  const report = f.report(); assert.ok(report.receiptObservations.some(r => r.completedDelta === 2 && r.coalesced));
  assert.ok(report.samples.some(s => s.completionObservation?.coalesced && !s.completionObservation.exactFrameObserved)); f.api().cancel();
});

test('deadline, install rollback, cancellation and device generation replacement restore methods', () => {
  const f = fixture(); f.install(); f.tick(30000); assert.equal(f.report().status, 'timeout'); f.restored();
  const g = fixture(makePlan(), { installFails: true }); assert.equal(g.install().status, 'aborted'); g.restored();
  const h = fixture(); h.install(); h.native.deviceGeneration++; h.tick(10); assert.equal(h.report().stopReason, 'receipt-generation-changed'); h.restored();
  const j = fixture(); j.install(); j.api().cancel(); j.tick(50); assert.equal(j.report().status, 'cancelled'); j.restored();
});

test('invalid plans fail before installing any method; subsequent wrapper replacement is reported', () => {
  const f = fixture({ ...makePlan(), groups: [] }); assert.equal(f.install().status, 'unavailable'); assert.equal(f.api(), undefined);
  const g = fixture(); g.install(); const later = () => {}; g.gl.clear = later; g.api().cancel(); assert.equal(g.gl.clear, later); assert.equal(g.report().methodsRestored, false);
});

test('large reports explicitly paginate every retained receipt under the 64 KiB transport ceiling', () => {
  const f = fixture(); f.install();
  for (let i = 1; i <= 240; i++) { f.native.frameId = i; f.native.completed = i; f.tick(10); }
  const report = f.api().report(); assert.equal(report.paged, true); assert.ok(Buffer.byteLength(JSON.stringify(report)) < 60000);
  const recovered = []; for (let offset = 0; offset < report.collections.receiptObservations;) {
    const page = f.api().read('receiptObservations', offset, 32); assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(page))) < 60000); recovered.push(...page.rows); offset = page.nextOffset;
  }
  assert.equal(recovered.length, report.collections.receiptObservations); assert.equal(recovered.at(-1).completed, 240);
  assert.equal(f.api().read('__proto__').status, 'invalid-page'); f.api().cancel();
});

test('the official pretty-printed automation envelope survives its observed 65,536-byte stdout limit', () => {
  // Matches the actual automation_evaluate stdout shape from the 2026-10-11
  // split-P10/P11 failure, whose stdout.txt ended mid-prefixExclusions at byte 65536.
  const transport = value => Buffer.from(JSON.stringify({ ok: true, tool: 'automation_evaluate', clientName: 'Codex', result: { success: true, result: value } }, null, 2)).subarray(0, 65536).toString('utf8');
  const groups = [{ name: 'normal', workIndices: [] }, { name: 'omit-p10', workIndices: [12] }, { name: 'omit-p11', workIndices: [13] }, { name: 'omit-both', workIndices: [12, 13] }];
  const f = fixture(makePlan(groups), { clockFraction: 0.099999904633 }); f.install();
  // Native completion and submission are observed independently in the real
  // failure. Retain extra distinct receipt observations before the sample fence.
  for (let i = 1; i <= 40; i++) { f.native.frameId = i; f.native.completed = Math.max(0, i - 2); f.tick(10); }
  f.frame();
  for (let index = 0; index < 20; index++) {
    f.gl.blitFramebuffer(0, 1170, 2532, 0, 0, 0, 2532, 1170, 16384, 9728); f.frame();
  }
  f.frame(); f.frame(); f.frame();
  const report = f.api().report();
  assert.equal(report.status, 'complete');
  assert.doesNotThrow(() => JSON.parse(transport(report)), 'official envelope was truncated');
  assert.equal(report.paged, true);
  const legacyFull = { ...f.report(), paged: false };
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(legacyFull))) < 60000, 'fixture must pass the former compact double-encoding guard');
  assert.throws(() => JSON.parse(transport(legacyFull)), SyntaxError, 'the same evidence must reproduce real envelope truncation');
  for (const [collection, total] of Object.entries(report.collections)) {
    let offset = 0, size = 16;
    while (offset < total) {
      const page = f.api().read(collection, offset, size);
      if (page.status === 'page-too-large') { assert.ok(page.retryCount < size); size = page.retryCount; continue; }
      assert.doesNotThrow(() => JSON.parse(transport(page)));
      assert.ok(Buffer.byteLength(transport(page)) < 32768, 'page must leave room for the official envelope');
      offset = page.nextOffset;
    }
    assert.equal(offset, total);
  }
});

test('preparation preserves source byte identities, emits a self-contained installer and refuses to overwrite evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forgeax-draw-omission-'));
  try {
    const alignmentPath = join(dir, 'alignment.json'), tapePath = join(dir, 'frame.rhitape'), publicationPath = join(dir, 'forgeax-dist.json'), groupsPath = join(dir, 'groups.json'), out = join(dir, 'prepared');
    await Promise.all([writeFile(alignmentPath, JSON.stringify(alignment)), writeFile(tapePath, 'tape-fixture'), writeFile(publicationPath, JSON.stringify({ schemaVersion: '1.0.0', target: 'wechat', artifacts: [] })), writeFile(groupsPath, JSON.stringify(defaultGroups))]);
    const prepared = await prepareFiles({ alignmentPath, tapePath, publicationPath, groupsPath, out });
    assert.equal(prepared.source.tape.digest, 'sha256:' + createHash('sha256').update('tape-fixture').digest('hex'));
    const installer = vm.runInNewContext(await readFile(join(out, 'install.js'), 'utf8')); assert.equal(typeof installer, 'function');
    assert.ok(!(await readFile(join(out, 'plan.json'), 'utf8')).includes(dir));
    await assert.rejects(prepareFiles({ alignmentPath, tapePath, publicationPath, groupsPath, out }), /EEXIST/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

if (process.env.FORGEAX_DRAW_OMISSION_PLAN) {
  test('prepared target plan preserves every aligned operation and exact selected work set', async () => {
    const plan = JSON.parse(await readFile(process.env.FORGEAX_DRAW_OMISSION_PLAN, 'utf8'));
    const f = fixture(plan); f.install(); f.frame();
    for (let index = 0; index < plan.groups.length * 5; index++) {
      const before = f.calls.length; f.frame();
      const sample = f.report().samples[index], group = plan.groups[Math.floor(index / 5)];
      const expected = plan.operations.filter(operation => operation.workIndex !== null && !group.workIndices.includes(operation.workIndex));
      const forwarded = f.calls.slice(before).filter(call => call.name.startsWith('draw'));
      assert.deepEqual(forwarded.map(call => [call.name, call.args]), expected.map(operation => [operation.method, operation.args]));
      assert.equal(sample.skippedDraws, group.workIndices.length); assert.equal(sample.structureMatch, true);
    }
    f.frame(); f.frame(); f.frame(); assert.equal(f.report().status, 'complete'); f.restored();
  });
}

test('unremovable wrappers are reported as restore failures, including non-strict injected realms', () => {
  const f = fixture(); f.install(); Object.defineProperty(f.gl, 'clear', { value: f.gl.clear, configurable: false });
  f.api().cancel(); assert.equal(f.report().status, 'restore-failed'); assert.equal(f.report().methodsRestored, false);
});

test('diagnostic argument inspection cannot replace an original call or its exception', () => {
  const f = fixture(); f.install(); f.frame(); f.gl.clear(256); f.gl.drawElementsInstanced(4, 3, 5125, 12, 1);
  const unreadable = new Proxy([], { get() { throw Error('argument inspection'); } });
  const sentinel = {}; f.config.throwMethod = 'clearBufferfv'; f.config.sentinel = sentinel;
  assert.throws(() => f.gl.clearBufferfv(6144, 0, unreadable), error => error === sentinel);
  f.restored(); assert.equal(f.report().stopReason, 'operation-mismatch');
});

test('poll detects a replaced wrapper during sampling and preserves its new owner', () => {
  const f = fixture(); f.install(); f.frame(); const replacement = () => {}; f.gl.clear = replacement; f.tick(10);
  assert.equal(f.report().stopReason, 'method-replaced'); assert.equal(f.report().status, 'restore-failed');
  assert.equal(f.gl.clear, replacement); assert.equal(f.report().methodsRestored, false);
});
