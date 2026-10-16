import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

/** Select existing FrameModel work indices through an independently verified GL alignment. */
export function prepareDrawOmissionPlan(alignment, groups, source) {
  const fail = message => { throw new Error(message); };
  if (alignment?.success !== true || alignment.programMappingOneToOne !== true || !Array.isArray(alignment.failures) || alignment.failures.length)
    fail('alignment must have succeeded without failures and retain a one-to-one program mapping');
  if (!Array.isArray(alignment.draws) || alignment.draws.length !== alignment.matchedDraws || !Array.isArray(alignment.clears)) fail('invalid alignment cardinality');
  if (!Number.isInteger(alignment.glEvents) || alignment.glEvents < 1 || alignment.glEvents > 512) fail('alignment must contain 1–512 operations');
  const operations = Array(alignment.glEvents).fill(null), workIndices = new Set();
  const normalizeArg = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value && Number.isInteger(value.length) && value.length > 0 && value.length <= 16 && Array.isArray(value.first) && value.first.length === value.length && value.first.every(v => typeof v === 'number' && Number.isFinite(v)))
      return { values: value.first.slice() };
    fail('alignment arguments must contain finite numbers or complete bounded numeric array contents');
  };
  for (const row of alignment.draws) {
    if (row.drawRequestMatches !== true || !Number.isInteger(row.rhiWorkIndex) || row.rhiWorkIndex < 0 || workIndices.has(row.rhiWorkIndex)) fail('draw alignment is incomplete or repeats a workIndex');
    if (!['drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced', 'drawRangeElements'].includes(row.glMethod)) fail('unsupported aligned draw method');
    workIndices.add(row.rhiWorkIndex);
    add(row.glEventId, row.glMethod, row.glArgs, row.rhiWorkIndex, row.pipelineId);
  }
  for (const row of alignment.clears) {
    if (!['clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi'].includes(row.method)) fail('unsupported aligned clear method');
    add(row.glEventId, row.method, row.args, null, null);
  }
  function add(index, method, args, workIndex, pipelineId) {
    if (!Number.isInteger(index) || index < 0 || index >= operations.length || operations[index]) fail('GL operation indices must be unique and contiguous');
    if (!Array.isArray(args) || args.length < 1 || args.length > 12) fail('invalid GL argument count');
    operations[index] = { method, args: args.map(normalizeArg), workIndex, pipelineId };
  }
  if (operations.some(row => row === null)) fail('alignment leaves an unverified GL operation');
  if (!Array.isArray(groups) || groups.length < 2 || groups.length > 8) fail('provide 2–8 groups, beginning with an unmodified control');
  const names = new Set();
  const selections = groups.map(group => {
    if (!group || typeof group.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(group.name) || names.has(group.name)) fail('group names must be unique short identifiers');
    names.add(group.name);
    if (!Array.isArray(group.workIndices) || new Set(group.workIndices).size !== group.workIndices.length || group.workIndices.some(index => !workIndices.has(index))) fail('group references a missing or duplicate FrameModel workIndex');
    return { name: group.name, workIndices: group.workIndices.slice().sort((a, b) => a - b) };
  });
  if (selections[0].workIndices.length) fail('the first group must be an unmodified control');
  for (const name of ['alignment', 'tape', 'publication']) {
    if (!source?.[name] || !/^sha256:[a-f0-9]{64}$/.test(source[name].digest) || !Number.isSafeInteger(source[name].bytes) || source[name].bytes < 1) fail(`missing ${name} byte identity`);
  }
  return { version: 1, source: structuredClone(source), operations, groups: selections };
}

export function installDrawOmissionProbe(options = {}) {
  const root = globalThis, key = '__forgeaxDrawOmissionProbe';
  if (root[key]) return { status: 'already-installed' };
  let plan;
  try {
    plan = JSON.parse(JSON.stringify(options.plan));
    if (plan?.version !== 1 || !Array.isArray(plan.operations) || plan.operations.length < 1 || plan.operations.length > 512 || !Array.isArray(plan.groups) || plan.groups.length < 2 || plan.groups.length > 8) throw Error('invalid prepared plan');
    const seen = new Set();
    const draws = ['drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced', 'drawRangeElements'];
    const clears = ['clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi'];
    for (const operation of plan.operations) {
      if (![...draws, ...clears].includes(operation.method) || !Array.isArray(operation.args) || operation.args.length < 1 || operation.args.length > 12) throw Error('invalid operation');
      if (!operation.args.every(value => typeof value === 'number' && Number.isFinite(value) || value && Array.isArray(value.values) && value.values.length > 0 && value.values.length <= 16 && value.values.every(v => typeof v === 'number' && Number.isFinite(v)))) throw Error('invalid operation arguments');
      if (draws.includes(operation.method)) {
        if (!Number.isInteger(operation.workIndex) || operation.workIndex < 0 || seen.has(operation.workIndex)) throw Error('invalid workIndex');
        seen.add(operation.workIndex);
      } else if (operation.workIndex !== null) throw Error('clear must not select a work');
    }
    const names = new Set();
    for (const group of plan.groups) {
      if (typeof group.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(group.name) || names.has(group.name) || !Array.isArray(group.workIndices) || new Set(group.workIndices).size !== group.workIndices.length || group.workIndices.some(index => !seen.has(index))) throw Error('invalid group');
      names.add(group.name);
    }
    if (plan.groups[0].workIndices.length) throw Error('first group must be control');
    const source = {};
    for (const name of ['alignment', 'tape', 'publication']) {
      const value = plan.source?.[name];
      if (!/^sha256:[a-f0-9]{64}$/.test(value?.digest) || typeof value.file !== 'string' || value.file.length > 255 || !Number.isSafeInteger(value.bytes) || value.bytes < 1) throw Error('missing source identity');
      source[name] = { file: value.file, bytes: value.bytes, digest: value.digest };
    }
    plan.source = source;
  } catch (error) { return { status: 'unavailable', reason: 'invalid-plan', detail: String(error).slice(0, 200) }; }
  const canvas = options.canvas;
  const expected = plan.operations, selections = plan.groups.map(group => new Set(group.workIndices));
  const expectedDraws = expected.filter(operation => operation.workIndex !== null).length;
  function matches(method, args, operation) {
    try {
    if (!operation || method !== operation.method || args.length !== operation.args.length) return false;
    return operation.args.every((value, index) => {
      const actual = args[index];
      if (typeof value === 'number') return actual === value;
      return (ArrayBuffer.isView(actual) || Array.isArray(actual)) && actual.length === value.values.length && value.values.every((element, i) => actual[i] === element);
    });
    } catch { return false; }
  }
  function argumentView(args) {
    try {
    return args.slice(0, 12).map(value => typeof value === 'number' ? value : (ArrayBuffer.isView(value) || Array.isArray(value)) ? { length: value.length, values: Array.from({ length: Math.min(value.length, 16) }, (_, index) => value[index]) } : { type: typeof value });
    } catch { return [{ unreadable: true }]; }
  }
  let gl;
  try { if (!canvas || !(gl = canvas.getContext('webgl2'))) return { status: 'unavailable', reason: 'explicit canvas webgl2 missing' }; }
  catch (error) { return { status: 'unavailable', reason: String(error).slice(0, 200) }; }
  let lastNow = 0;
  const now = () => { try { const value = root.performance.now(); if (Number.isFinite(value)) lastNow = value; } catch {} return lastNow; };
  const message = value => { try { return String(value?.message ?? value).slice(0, 200); } catch { return 'unprintable'; } };
  const installedAtMs = now(), deadlineMs = installedAtMs + 30000, pollMs = 10;
  const readReceipt = options.readReceipt ?? (() => root.GameGlobal?.__gameContextWindow?.__forgeaxGameInspection?.renderer?.());
  const groups = plan.groups.map(group => group.name), framesPerGroup = 5, totalFrames = groups.length * framesPerGroup;
  const samples = [], receipts = [], prefixExclusions = [], errors = [], restores = [];
  let phase = 'aligning', status = 'armed', stopReason, activeSample, alignedAtMs, restoredAtMs;
  let mismatch, timer, deadlineTimer, prefixSkippedCount = 0, restoreFailures = 0, restoredReadyReceipt, lastReceipt, receiptReadFailures = 0;
  const errorAt = (stage, error) => { if (errors.length < 8) errors.push({ stage, message: message(error) }); };
  function projectReceipt() {
    const atMs = now();
    try {
      const value = readReceipt();
      if (!value || typeof value.then === 'function') return { atMs, available: false };
      const pick = (value, names) => Object.fromEntries(names.flatMap(name => {
        const item = value?.[name]; return item === null || ['number', 'boolean', 'string'].includes(typeof item) ? [[name, typeof item === 'string' ? item.slice(0, 100) : item]] : [];
      }));
      return { atMs, available: true, ...pick(value, ['generation', 'phase', 'completed', 'presented']),
        lastCompletion: pick(value.lastCompletion, ['frameId', 'deviceGeneration', 'presentation']),
        frame: pick(value.frame, ['frameId', 'deviceGeneration', 'pendingCompletionCount']) };
    } catch (error) { receiptReadFailures++; return { atMs, available: false, error: message(error) }; }
  }
  function observeReceipt() {
    const current = projectReceipt();
    if (!current.available) return current;
    if (lastReceipt && (current.generation !== lastReceipt.generation || current.frame.deviceGeneration !== lastReceipt.frame.deviceGeneration || current.completed < lastReceipt.completed)) {
      abort('receipt-generation-changed'); return current;
    }
    const changed = !lastReceipt || current.completed !== lastReceipt.completed || current.lastCompletion.frameId !== lastReceipt.lastCompletion.frameId || current.frame.frameId !== lastReceipt.frame.frameId;
    if (changed) {
      current.previousObservedAtMs = lastReceipt?.atMs;
      current.previousCompleted = lastReceipt?.completed;
      current.completedDelta = lastReceipt ? current.completed - lastReceipt.completed : null;
      current.coalesced = typeof current.completedDelta === 'number' && current.completedDelta > 1;
      if (receipts.length >= 512) { abort('receipt-evidence-limit'); return current; }
      receipts.push(current);
    }
    for (const sample of samples) {
      if (!sample.afterFenceReceipt?.available || sample.completionObservation) continue;
      const target = sample.frameId;
      if (typeof target !== 'number' || current.generation !== sample.afterFenceReceipt.generation || current.lastCompletion.presentation !== 'ready' || current.lastCompletion.frameId < target) continue;
      sample.completionObservation = { atMs: current.atMs, observedFrameId: current.lastCompletion.frameId, completed: current.completed,
        exactFrameObserved: current.lastCompletion.frameId === target, coalesced: current.coalesced === true || current.lastCompletion.frameId > target,
        previousObservedAtMs: lastReceipt?.atMs, previousCompleted: lastReceipt?.completed };
    }
    lastReceipt = current;
    const finalSample = samples[totalFrames - 1];
    if (phase === 'restored' && finalSample?.frameId !== undefined && current.generation === finalSample.afterFenceReceipt?.generation &&
        current.lastCompletion.presentation === 'ready' && current.lastCompletion.frameId > finalSample.frameId) restoredReadyReceipt = current;
    return current;
  }
  function restore() {
    for (const entry of restores.splice(0).reverse()) {
      try {
        if (Object.getOwnPropertyDescriptor(gl, entry.name)?.value !== entry.wrapper) { restoreFailures++; errorAt('restore-conflict', entry.name); }
        else if (entry.descriptor) Object.defineProperty(gl, entry.name, entry.descriptor);
        else if (!Reflect.deleteProperty(gl, entry.name)) throw Error('restore-delete-failed');
      } catch (error) { restoreFailures++; errorAt('restore', error); }
    }
    restoredAtMs ??= now();
  }
  function finish(result, reason) {
    if (phase === 'done') return;
    phase = 'done'; status = result; stopReason = reason; restore();
    if (restoreFailures) status = 'restore-failed';
    try { root.clearTimeout(timer); root.clearTimeout(deadlineTimer); } catch (error) { errorAt('clear-timers', error); }
  }
  function abort(reason, error) { if (error) errorAt(reason, error); try { finish('aborted', reason); } catch (failure) { errorAt('abort-cleanup', failure); } }
  function poll() {
    if (phase === 'done') return;
    try {
      for (const entry of restores) {
        if (Object.getOwnPropertyDescriptor(gl, entry.name)?.value !== entry.wrapper) { abort('method-replaced'); return; }
      }
      observeReceipt();
      if (phase === 'done') return;
      if (restoredReadyReceipt && samples.length === totalFrames && samples.every(s => s.structureMatch && s.completionObservation)) {
        finish('complete', 'restored-ready-observed'); return;
      }
      timer = root.setTimeout(poll, pollMs);
    } catch (error) { abort('receipt-poll-failed', error); }
  }
  function install(name, wrapper) {
    const descriptor = Object.getOwnPropertyDescriptor(gl, name);
    if (descriptor && !('value' in descriptor)) throw new Error(`accessor:${name}`);
    Object.defineProperty(gl, name, descriptor ? { ...descriptor, value: wrapper } : { value: wrapper, writable: true, configurable: true });
    restores.push({ name, descriptor, wrapper });
  }
  function encodedBytes(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 128) bytes++; else if (code < 2048) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
      else bytes += 3;
    }
    return bytes;
  }
  function transportBytes(value) {
    // The official CLI pretty-prints this wrapper before its 65,536-byte stdout
    // cut. Also budget an escaped transport layer and 4 KiB of envelope headroom.
    const text = JSON.stringify({ ok: true, tool: 'automation_evaluate', clientName: 'Codex', result: { success: true, result: value } }, null, 2);
    return Math.max(encodedBytes(text), encodedBytes(JSON.stringify(text))) + 4096;
  }
  const api = {
    report() {
      const summary = { kind: 'bounded-aligned-work-omission', phase, status, stopReason, installedAtMs, deadlineMs, pollMs,
        source: plan.source, groups: plan.groups.map(group => ({ name: group.name, omittedWorks: group.workIndices.length })), framesPerGroup, discardFirstCompletedPerGroup: 2, totalFrames,
        expectedOperations: expected.length, expectedDraws, alignedAtMs, restoredAtMs, methodsRestored: restores.length === 0 && restoreFailures === 0,
        restoreFailures, prefixSkippedCount, receiptReadFailures, mismatch, errors: errors.slice(), restoredReadyReceipt,
        interpretation: 'Diagnostic omission changes pixels, not a production optimization. Select existing FrameModel workIndex values; method and full effective arguments must match the aligned publication. Receipt timestamps are observations; coalesced jumps are not exact completion times. No GPU query or GL getter is used.' };
      return { ...summary, paged: true, collections: { groups: plan.groups.length, samples: samples.length, receiptObservations: receipts.length, prefixExclusions: prefixExclusions.length },
        pageCall: 'read(collection, offset, count)', defaultPageCount: 4, transportBudgetBytes: 32768 };
    },
    read(collection, offset = 0, count = 4) {
      const rows = { groups: plan.groups, samples, receiptObservations: receipts, prefixExclusions }[collection];
      if (!Array.isArray(rows) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 1 || count > 32) return { status: 'invalid-page' };
      const page = { collection, offset, total: rows.length, rows: rows.slice(offset, offset + count), nextOffset: Math.min(rows.length, offset + count) };
      if (transportBytes(page) > 32768) return { status: 'page-too-large', collection, offset, retryCount: Math.max(1, Math.floor(count / 2)) };
      return page;
    },
    cancel() { finish('cancelled', 'cancelled'); return api.report(); },
    release() { api.cancel(); if (root[key] === api) delete root[key]; return { released: true, methodsRestored: restores.length === 0 && restoreFailures === 0 }; },
  };
  root[key] = api;
  try {
    observeReceipt();
    for (const method of ['drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced', 'drawRangeElements', 'clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi', 'blitFramebuffer']) {
      const original = gl[method]; if (typeof original !== 'function') continue;
      const isDraw = method.startsWith('draw');
      install(method, function (...args) {
        if (this !== gl || !['waiting', 'capturing'].includes(phase)) return Reflect.apply(original, this, args);
        if (phase === 'waiting') {
          if (method === 'blitFramebuffer') {
            const calledAtMs = now(); let threw = false;
            try { return Reflect.apply(original, this, args); }
            catch (error) { threw = true; throw error; }
            finally { try {
              const returnedAtMs = now(); prefixSkippedCount++;
              if (prefixExclusions.length >= 128) abort('prefix-evidence-limit');
              else prefixExclusions.push({ beforeSample: samples.length, method, args: argumentView(args), calledAtMs, returnedAtMs, cpuMs: returnedAtMs - calledAtMs });
              if (threw) abort('prefix-call-threw');
            } catch (error) { abort('prefix-finally', error); } }
          }
          if (!matches(method, args, expected[0])) {
            mismatch = { eventIndex: 0, expected: expected[0], actual: { method, args: argumentView(args) } };
            errorAt('first-operation', method); abort('first-operation-mismatch'); return Reflect.apply(original, this, args);
          }
          const groupIndex = Math.floor(samples.length / framesPerGroup), frameInGroup = samples.length % framesPerGroup;
          activeSample = { id: samples.length, group: groups[groupIndex], groupIndex, frameInGroup, discardForInFlight: frameInGroup < 2,
            frameStartedAtMs: now(), events: 0, observedDraws: 0, forwardedDraws: 0, skippedDraws: 0, clearCalls: 0 };
          samples.push(activeSample); phase = 'capturing';
        }
        const sample = activeSample, index = sample.events++; if (isDraw) sample.observedDraws++; else if (method.startsWith('clear')) sample.clearCalls++;
        if (!matches(method, args, expected[index])) {
          mismatch = { eventIndex: index, expected: expected[index] ?? null, actual: { method, args: argumentView(args) } };
          abort('operation-mismatch'); return Reflect.apply(original, this, args);
        }
        if (isDraw && selections[sample.groupIndex].has(expected[index].workIndex)) { sample.skippedDraws++; return undefined; }
        if (isDraw) sample.forwardedDraws++;
        try { return Reflect.apply(original, this, args); }
        catch (error) { abort('original-call-threw'); throw error; }
      });
    }
    const originalFence = gl.fenceSync;
    if (typeof originalFence !== 'function') throw new Error('fenceSync missing');
    install('fenceSync', function (...args) {
      if (this !== gl || !['aligning', 'capturing'].includes(phase)) return Reflect.apply(originalFence, this, args);
      const calledAtMs = now(); let result, threw = false;
      try { result = Reflect.apply(originalFence, this, args); return result; }
      catch (error) { threw = true; throw error; }
      finally { try {
        if (threw || result === null) abort('fence-failed');
        else if (phase === 'aligning') { alignedAtMs = now(); phase = 'waiting'; }
        else if (phase === 'capturing') {
          const sample = activeSample; sample.fenceCalledAtMs = calledAtMs; sample.fenceReturnedAtMs = now(); sample.submitWallMs = calledAtMs - sample.frameStartedAtMs;
          const expectedSkipped = selections[sample.groupIndex].size;
          sample.structureMatch = sample.events === expected.length && sample.observedDraws === expectedDraws && sample.clearCalls === expected.length - expectedDraws && sample.skippedDraws === expectedSkipped && sample.forwardedDraws === expectedDraws - expectedSkipped;
          root.queueMicrotask(() => {
            if (phase === 'done') return;
            sample.afterFenceReceipt = projectReceipt(); sample.frameId = sample.afterFenceReceipt.frame?.frameId;
            if (!sample.afterFenceReceipt.available || typeof sample.frameId !== 'number') { abort('submission-receipt-unavailable'); return; }
            const previous = samples[sample.id - 1];
            if (previous?.frameId !== undefined && sample.frameId <= previous.frameId) { abort('submission-frame-not-increasing'); return; }
            observeReceipt();
          });
          if (!sample.structureMatch) abort('structure-mismatch');
          else { activeSample = undefined; phase = samples.length === totalFrames ? 'restored' : 'waiting'; if (phase === 'restored') restore(); }
        }
      } catch (error) { abort('fence-finally', error); } }
    });
    timer = root.setTimeout(poll, pollMs);
    deadlineTimer = root.setTimeout(() => finish('timeout', 'deadline'), Math.max(0, deadlineMs - now()));
  } catch (error) { abort('install-failed', error); }
  return api.report();
}

async function fileIdentity(path) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { file: basename(path), bytes, digest: 'sha256:' + hash.digest('hex') };
}
export async function prepareFiles({ alignmentPath, tapePath, publicationPath, groupsPath, out }) {
  const [alignmentBytes, publicationBytes, groupBytes, tape] = await Promise.all([
    readFile(alignmentPath), readFile(publicationPath), readFile(groupsPath), fileIdentity(tapePath),
  ]);
  const publication = JSON.parse(publicationBytes);
  if (publication.schemaVersion !== '1.0.0' || publication.target !== 'wechat' || !Array.isArray(publication.artifacts)) throw Error('publication must be the WeChat forgeax-dist.json inventory');
  const source = {
    alignment: { file: basename(alignmentPath), bytes: alignmentBytes.length, digest: digest(alignmentBytes) }, tape,
    publication: { file: basename(publicationPath), bytes: publicationBytes.length, digest: digest(publicationBytes) },
  };
  const plan = prepareDrawOmissionPlan(JSON.parse(alignmentBytes), JSON.parse(groupBytes), source);
  const installer = '(' + installDrawOmissionProbe.toString() + ')\n';
  await mkdir(out);
  await writeFile(join(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  await writeFile(join(out, 'install.js'), installer);
  return { status: 'prepared', out, source, planDigest: digest(JSON.stringify(plan)), installerDigest: digest(installer),
    groups: plan.groups.map(group => ({ name: group.name, omittedWorks: group.workIndices.length })) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { alignment: { type: 'string' }, tape: { type: 'string' }, publication: { type: 'string' }, groups: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } } });
  const usage = 'node draw_omission.mjs --alignment MATCHED_JSON --tape FRAME_RHITAPE --publication FORGEAX_DIST_JSON --groups GROUPS_JSON --out NEW_DIRECTORY';
  if (values.help) console.log(usage);
  else {
    if (['alignment', 'tape', 'publication', 'groups', 'out'].some(name => !values[name])) throw Error(usage);
    console.log(JSON.stringify(await prepareFiles({ alignmentPath: values.alignment, tapePath: values.tape, publicationPath: values.publication, groupsPath: values.groups, out: values.out })));
  }
}
