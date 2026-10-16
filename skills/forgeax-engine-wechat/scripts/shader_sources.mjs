import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** Project an existing verified omission plan; workIndex remains the RHI identity. */
export function prepareShaderSourcePlan(input, selectedPrograms = input?.selectedPrograms) {
  const fail = message => { throw Error(message); };
  if (input?.version !== 1 || !Array.isArray(input.operations) || input.operations.length < 2 || input.operations.length > 512) fail('invalid prepared operation plan');
  const source = {};
  for (const name of ['alignment', 'tape', 'publication', 'preparedPlan']) {
    const item = input.source?.[name];
    if (name === 'preparedPlan' && item === undefined) continue;
    if (!item || typeof item.file !== 'string' || item.file.length > 255 || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || !/^sha256:[a-f0-9]{64}$/.test(item.digest)) fail('missing source byte identity: ' + name);
    source[name] = { file: item.file, bytes: item.bytes, digest: item.digest };
  }
  const drawMethods = ['drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced', 'drawRangeElements'];
  const clearMethods = ['clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi'];
  const works = new Set(), pipelines = new Map(), programs = [];
  const operations = input.operations.map((operation, index) => {
    if (![...drawMethods, ...clearMethods].includes(operation?.method) || !Array.isArray(operation.args) || operation.args.length < 1 || operation.args.length > 12) fail('invalid operation');
    const args = operation.args.map(value => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (value && Array.isArray(value.values) && value.values.length > 0 && value.values.length <= 16 && value.values.every(n => typeof n === 'number' && Number.isFinite(n))) return { values: value.values.slice() };
      fail('incomplete operation arguments');
    });
    if (!drawMethods.includes(operation.method)) {
      if (operation.workIndex !== null || operation.pipelineId !== null) fail('clear must have no work or pipeline');
      return { method: operation.method, args, workIndex: null, pipelineId: null, programOrdinal: null };
    }
    if (!Number.isSafeInteger(operation.workIndex) || operation.workIndex < 0 || works.has(operation.workIndex) || typeof operation.pipelineId !== 'string' || operation.pipelineId.length < 1 || operation.pipelineId.length > 128) fail('invalid draw identity');
    works.add(operation.workIndex);
    let program = pipelines.get(operation.pipelineId);
    if (!program) {
      if (programs.length === 32) fail('at most 32 observed programs');
      program = { ordinal: programs.length + 1, pipelineId: operation.pipelineId, workIndices: [], glEventIndices: [] };
      pipelines.set(operation.pipelineId, program); programs.push(program);
    }
    program.workIndices.push(operation.workIndex); program.glEventIndices.push(index);
    return { method: operation.method, args, workIndex: operation.workIndex, pipelineId: operation.pipelineId, programOrdinal: program.ordinal };
  });
  if (operations[0].method !== 'clear' || operations[0].args.length !== 1 || operations[0].args[0] !== 256) fail('the verified natural frame must begin with clear(256)');
  if (!programs.length) fail('no aligned programs');
  const selected = selectedPrograms ?? programs.map(program => program.ordinal);
  if (!Array.isArray(selected) || selected.length < 1 || new Set(selected).size !== selected.length || selected.some(ordinal => !Number.isInteger(ordinal) || ordinal < 1 || ordinal > programs.length)) fail('select existing program ordinals, or omit selection for all programs');
  return { version: 1, source, operations, programs, selectedPrograms: selected.slice().sort((a, b) => a - b) };
}

export function installShaderSourceProbe(options = {}) {
  const root = globalThis, key = '__forgeaxShaderSourceProbe';
  if (root[key]) return { status: 'already-installed' };
  if (root.__forgeaxDrawOmissionProbe) return { status: 'unavailable', reason: 'release-draw-omission-probe-first' };
  let plan, gl;
  try {
    plan = prepareShaderSourcePlan(options.plan);
    gl = options.canvas?.getContext('webgl2');
    if (!gl) throw Error('explicit canvas webgl2 missing');
  } catch (error) { return { status: 'unavailable', reason: String(error).slice(0, 200) }; }
  const message = error => { try { return String(error?.message ?? error).slice(0, 200); } catch { return 'unprintable'; } };
  let lastNow = 0;
  const now = () => { try { const value = root.performance.now(); if (Number.isFinite(value)) lastNow = value; } catch {} return lastNow; };
  const readReceipt = options.readReceipt ?? (() => root.GameGlobal?.__gameContextWindow?.__forgeaxGameInspection?.renderer?.());
  function receipt() {
    const value = readReceipt();
    if (!value || typeof value.then === 'function' || !Number.isSafeInteger(value.generation) || !Number.isSafeInteger(value.frame?.frameId) || !Number.isSafeInteger(value.frame?.deviceGeneration)) throw Error('native renderer receipt unavailable');
    return { atMs: now(), generation: value.generation, frameId: value.frame.frameId, deviceGeneration: value.frame.deviceGeneration };
  }
  let initialReceipt;
  try { initialReceipt = receipt(); } catch (error) { return { status: 'unavailable', reason: message(error) }; }
  const installedAtMs = now(), deadlineMs = installedAtMs + 30000;
  const originals = [], handleOrdinals = new Map(), handles = [], draws = [], records = [], errors = [];
  const selected = new Set(plan.selectedPrograms);
  let phase = 'aligning', status = 'armed', stopReason, timer, deadlineTimer, currentProgram;
  let observedOperations = 0, useProgramCalls = 0, prefixBlits = 0, prefixFences = 0, alignedAtMs, frameStartedAtMs, fenceCalledAtMs, fenceReturnedAtMs, restoredAtMs, sourcesStartedAtMs, afterFenceReceipt;
  let mismatch, restoreFailures = 0, totalSourceBytes = 0, nextProgram = 0, debugShaders;
  let extension = { availability: 'not-read' };
  const errorAt = (stage, error) => { if (errors.length < 8) errors.push({ stage, message: message(error) }); };
  function sameGeneration() {
    const value = receipt();
    if (value.generation !== initialReceipt.generation || value.deviceGeneration !== initialReceipt.deviceGeneration || value.frameId < initialReceipt.frameId) throw Error('receipt-generation-changed');
    return value;
  }
  function restore() {
    for (const entry of originals.splice(0).reverse()) {
      try {
        if (Object.getOwnPropertyDescriptor(gl, entry.name)?.value !== entry.wrapper) throw Error('method ownership changed: ' + entry.name);
        if (entry.descriptor) Object.defineProperty(gl, entry.name, entry.descriptor);
        else if (!Reflect.deleteProperty(gl, entry.name)) throw Error('restore-delete-failed: ' + entry.name);
      } catch (error) { restoreFailures++; errorAt('restore', error); }
    }
    restoredAtMs ??= now();
  }
  function forgetHandles() { handleOrdinals.clear(); handles.length = 0; currentProgram = undefined; debugShaders = undefined; }
  function finish(result, reason) {
    if (phase === 'done') return;
    phase = 'done'; status = result; stopReason = reason; restore(); forgetHandles();
    if (restoreFailures) status = 'restore-failed';
    try { root.clearTimeout(timer); root.clearTimeout(deadlineTimer); } catch (error) { errorAt('clear-timers', error); }
  }
  function abort(reason, error) { if (error) errorAt(reason, error); finish('aborted', reason); }
  function live() {
    if (now() >= deadlineMs) { finish('timeout', 'deadline'); return false; }
    return phase !== 'done';
  }
  function matches(method, args, operation) {
    try {
      return operation?.method === method && args.length === operation.args.length && operation.args.every((value, i) => typeof value === 'number' ? args[i] === value :
        (ArrayBuffer.isView(args[i]) || Array.isArray(args[i])) && args[i].length === value.values.length && value.values.every((n, j) => args[i][j] === n));
    } catch { return false; }
  }
  function utf8Bytes(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 128) bytes++; else if (code < 2048) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
      else bytes += 3;
    }
    return bytes;
  }
  function fitsTransport(value) {
    const text = JSON.stringify({ ok: true, tool: 'automation_evaluate', clientName: 'Codex', result: { success: true, result: value } }, null, 2);
    return Math.max(utf8Bytes(text), utf8Bytes(JSON.stringify(text))) + 4096 <= 32768;
  }
  function source(getter) {
    if (!live()) throw Error('deadline');
    let text;
    try { text = getter(); }
    catch (error) { return { availability: 'failed', reason: message(error) }; }
    if (!live()) throw Error('deadline');
    if (typeof text !== 'string') return { availability: 'unavailable', reason: 'getter-returned-no-string' };
    const bytes = utf8Bytes(text);
    if (bytes > 2 * 1024 * 1024 || totalSourceBytes + bytes > 16 * 1024 * 1024) throw Error('source-byte-limit');
    totalSourceBytes += bytes;
    return { availability: 'available', chars: text.length, utf8Bytes: bytes, text };
  }
  function collectNext() {
    if (!live()) return;
    try {
      sameGeneration();
      if (originals.length || restoreFailures || restoredAtMs === undefined) throw Error('methods-not-restored');
      phase = 'collecting'; sourcesStartedAtMs ??= now();
      if (extension.availability === 'not-read') {
        try {
          debugShaders = typeof gl.getExtension === 'function' ? gl.getExtension('WEBGL_debug_shaders') : undefined;
          extension = debugShaders && typeof debugShaders.getTranslatedShaderSource === 'function' ? { availability: 'available' } : { availability: 'unavailable', reason: 'WEBGL_debug_shaders-not-exposed' };
        } catch (error) { extension = { availability: 'failed', reason: message(error) }; }
      }
      if (!live()) return;
      const ordinal = plan.selectedPrograms[nextProgram++], handle = handles[ordinal - 1];
      const record = { ordinal, availability: 'available', shaders: [] }; records.push(record);
      try {
        if (typeof gl.getAttachedShaders !== 'function' || typeof gl.getShaderParameter !== 'function') throw Error('shader-inspection-method-unavailable');
        const attached = gl.getAttachedShaders(handle);
        if (!live()) return;
        if (!Array.isArray(attached) || attached.length !== 2) throw Error('expected-two-attached-shaders');
        for (const shader of attached) {
          const type = gl.getShaderParameter(shader, 35663); // SHADER_TYPE, read only after restoration.
          if (!live()) return;
          const stage = type === 35633 ? 'vertex' : type === 35632 ? 'fragment' : null;
          if (!stage || record.shaders.some(item => item.stage === stage)) throw Error('ambiguous-attached-shader-stage');
          record.shaders.push({ stage,
            original: typeof gl.getShaderSource === 'function' ? source(() => gl.getShaderSource(shader)) : { availability: 'unavailable', reason: 'getShaderSource-not-exposed' },
            translated: extension.availability === 'available' ? source(() => debugShaders.getTranslatedShaderSource(shader)) : { availability: 'unavailable', reason: 'WEBGL_debug_shaders-not-available' },
          });
        }
      } catch (error) {
        if (phase === 'done' || message(error) === 'source-byte-limit') throw error;
        record.availability = 'failed'; record.reason = message(error);
      }
      handles[ordinal - 1] = undefined;
      sameGeneration();
      if (!live()) return;
      if (nextProgram === plan.selectedPrograms.length) {
        const complete = records.every(record => record.availability === 'available' && record.shaders.length === 2 && record.shaders.every(shader => shader.original.availability === 'available'));
        finish(complete ? 'complete' : 'partial', complete ? 'sources-collected' : 'original-source-unavailable');
      } else timer = root.setTimeout(collectNext, 0);
    } catch (error) { abort(message(error), error); }
  }
  function install(name, wrapper) {
    const descriptor = Object.getOwnPropertyDescriptor(gl, name);
    if (descriptor && !('value' in descriptor)) throw Error('accessor:' + name);
    Object.defineProperty(gl, name, descriptor ? { ...descriptor, value: wrapper } : { value: wrapper, writable: true, configurable: true });
    originals.push({ name, descriptor, wrapper });
  }
  function poll() {
    if (!live()) return;
    try {
      sameGeneration();
      for (const entry of originals) if (Object.getOwnPropertyDescriptor(gl, entry.name)?.value !== entry.wrapper) throw Error('method-replaced');
      timer = root.setTimeout(poll, 10);
    } catch (error) { abort(message(error), error); }
  }
  const metadata = value => value && Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'text'));
  const api = {
    report() {
      return { kind: 'bounded-aligned-shader-sources', phase, status, stopReason, installedAtMs, deadlineMs, source: plan.source,
        expectedOperations: plan.operations.length, observedOperations, expectedDraws: plan.operations.filter(operation => operation.workIndex !== null).length,
        observedDraws: draws.length, expectedPrograms: plan.programs.length, selectedPrograms: plan.selectedPrograms, collectedPrograms: records.length,
        useProgramCalls, prefixBlits, prefixFences, alignedAtMs, frameStartedAtMs, fenceCalledAtMs, fenceReturnedAtMs, restoredAtMs, sourcesStartedAtMs,
        initialReceipt, afterFenceReceipt, methodsRestored: originals.length === 0 && restoreFailures === 0, restoreFailures,
        retainedProgramHandles: handles.filter(Boolean).length, totalSourceBytes, extension, mismatch, errors: errors.slice(),
        programCall: 'program(ordinal)', drawCall: 'readDraws(offset, count)', sourceCall: 'readSource(ordinal, stage, kind, offset, count)', transportBudgetBytes: 32768,
        interpretation: 'One natural frame is matched by method and complete arguments to existing RHI workIndex values. Program ordinal is first aligned draw use, verified by a one-to-one handle/pipeline mapping. All GL getters run after the frame fence and method restoration. Original GLSL and optional driver translation are separate evidence; this is not a timing or pixel comparison.' };
    },
    program(ordinal) {
      const aligned = plan.programs.find(item => item.ordinal === ordinal), record = records.find(item => item.ordinal === ordinal);
      if (!aligned) return { status: 'invalid-program' };
      return { ...aligned, selected: selected.has(ordinal), availability: record?.availability ?? 'not-collected', reason: record?.reason,
        shaders: record?.shaders.map(shader => ({ stage: shader.stage, original: metadata(shader.original), translated: metadata(shader.translated) })) ?? [] };
    },
    readDraws(offset = 0, count = 16) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 1 || count > 64) return { status: 'invalid-page' };
      const page = { offset, total: draws.length, rows: draws.slice(offset, offset + count), nextOffset: Math.min(draws.length, offset + count) };
      return fitsTransport(page) ? page : { status: 'page-too-large', retryCount: Math.max(1, Math.floor(count / 2)) };
    },
    readSource(ordinal, stage, kind, offset = 0, count = 2048) {
      if (!['vertex', 'fragment'].includes(stage) || !['original', 'translated'].includes(kind) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 1 || count > 4096) return { status: 'invalid-page' };
      const value = records.find(item => item.ordinal === ordinal)?.shaders.find(item => item.stage === stage)?.[kind];
      if (!value || value.availability !== 'available') return { status: 'source-unavailable', ordinal, stage, kind, source: metadata(value) };
      if (offset > value.chars) return { status: 'invalid-page' };
      const splitPair = index => index > 0 && index < value.chars && value.text.charCodeAt(index - 1) >= 0xd800 && value.text.charCodeAt(index - 1) <= 0xdbff && value.text.charCodeAt(index) >= 0xdc00 && value.text.charCodeAt(index) <= 0xdfff;
      if (splitPair(offset)) return { status: 'invalid-page' };
      let end = Math.min(value.chars, offset + count);
      if (splitPair(end)) end--;
      if (end === offset && offset < value.chars) return { status: 'page-too-small', retryCount: 2 };
      const page = { ordinal, stage, kind, offset, totalChars: value.chars, utf8Bytes: value.utf8Bytes, text: value.text.slice(offset, end), nextOffset: end };
      return fitsTransport(page) ? page : { status: 'page-too-large', retryCount: Math.max(1, Math.floor(count / 2)) };
    },
    cancel() { finish('cancelled', 'cancelled'); return api.report(); },
    release() { api.cancel(); records.length = 0; draws.length = 0; totalSourceBytes = 0; if (root[key] === api) Reflect.deleteProperty(root, key); return { released: root[key] !== api, methodsRestored: originals.length === 0 && restoreFailures === 0 }; },
  };
  root[key] = api;
  try {
    for (const method of ['drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced', 'drawRangeElements', 'clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi', 'blitFramebuffer']) {
      const original = gl[method];
      if (typeof original !== 'function') { if (plan.operations.some(operation => operation.method === method)) throw Error('aligned method missing:' + method); continue; }
      install(method, function (...args) {
        if (this !== gl || !['waiting', 'capturing'].includes(phase)) return Reflect.apply(original, this, args);
        try {
          if (live()) {
            if (phase === 'waiting' && method === 'blitFramebuffer') { if (++prefixBlits > 128) abort('prefix-limit'); }
            else {
              const expected = plan.operations[observedOperations];
              if (!matches(method, args, expected)) { mismatch = { glEventIndex: observedOperations, expectedMethod: expected?.method, actualMethod: method }; abort('operation-mismatch'); }
              else {
                if (phase === 'waiting') { phase = 'capturing'; frameStartedAtMs = now(); }
                if (expected.workIndex !== null) {
                  if (!currentProgram || !['object', 'function'].includes(typeof currentProgram)) throw Error('draw-program-not-observed');
                  const ordinal = expected.programOrdinal, previous = handleOrdinals.get(currentProgram);
                  if (previous !== undefined && previous !== ordinal || handles[ordinal - 1] && handles[ordinal - 1] !== currentProgram) throw Error('program-mapping-mismatch');
                  if (previous === undefined) { if (ordinal !== handleOrdinals.size + 1) throw Error('program-order-mismatch'); handleOrdinals.set(currentProgram, ordinal); handles[ordinal - 1] = currentProgram; }
                  draws.push({ glEventIndex: observedOperations, workIndex: expected.workIndex, programOrdinal: ordinal });
                }
                observedOperations++;
              }
            }
          }
        } catch (error) { abort(message(error), error); }
        try { return Reflect.apply(original, this, args); } catch (error) { abort('original-call-threw'); throw error; }
      });
    }
    const originalUse = gl.useProgram, originalFence = gl.fenceSync;
    if (typeof originalUse !== 'function' || typeof originalFence !== 'function') throw Error('useProgram/fenceSync unavailable');
    install('useProgram', function (...args) {
      let result;
      try { result = Reflect.apply(originalUse, this, args); }
      catch (error) { if (this === gl) abort('useProgram-threw'); throw error; }
      if (this === gl && ['aligning', 'waiting', 'capturing'].includes(phase)) {
        try { if (live()) { if (++useProgramCalls > 4096) abort('useProgram-limit'); else currentProgram = args[0]; } }
        catch (error) { abort('useProgram-observation-failed', error); }
      }
      return result;
    });
    install('fenceSync', function (...args) {
      if (this !== gl || !['aligning', 'waiting', 'capturing'].includes(phase)) return Reflect.apply(originalFence, this, args);
      const calledAtMs = now(); let result, threw = false;
      try { result = Reflect.apply(originalFence, this, args); return result; }
      catch (error) { threw = true; throw error; }
      finally {
        try {
          if (threw || result == null) abort('fence-failed');
          else if (live()) {
            if (phase === 'aligning') { alignedAtMs = now(); phase = 'waiting'; currentProgram = undefined; }
            // HAL submit and onSubmittedWorkDone can each issue a fence. Until
            // clear(256) starts the selected frame, later fences are only prefix.
            else if (phase === 'waiting') { if (++prefixFences > 128) abort('prefix-fence-limit'); }
            else if (observedOperations !== plan.operations.length || handleOrdinals.size !== plan.programs.length) {
              mismatch = { kind: 'frame-fence', phase, expectedOperations: plan.operations.length, observedOperations,
                expectedPrograms: plan.programs.length, observedPrograms: handleOrdinals.size, observedDraws: draws.length };
              abort('frame-structure-mismatch');
            }
            else {
              fenceCalledAtMs = calledAtMs; fenceReturnedAtMs = now(); phase = 'restored'; restore(); handleOrdinals.clear(); currentProgram = undefined;
              if (restoreFailures) finish('restore-failed', 'restore-failed');
              else {
                for (let i = 0; i < handles.length; i++) if (!selected.has(i + 1)) handles[i] = undefined;
                root.clearTimeout(timer);
                root.queueMicrotask(() => {
                  if (!live()) return;
                  try { afterFenceReceipt = sameGeneration(); timer = root.setTimeout(collectNext, 0); }
                  catch (error) { abort(message(error), error); }
                });
              }
            }
          }
        } catch (error) { abort('fence-finally', error); }
      }
    });
    timer = root.setTimeout(poll, 10);
    deadlineTimer = root.setTimeout(() => finish('timeout', 'deadline'), Math.max(0, deadlineMs - now()));
  } catch (error) { abort('install-failed', error); }
  return api.report();
}

export function shaderSourceInstaller() {
  return '(function(){const prepareShaderSourcePlan=' + prepareShaderSourcePlan.toString() + ';return ' + installShaderSourceProbe.toString() + ';})()\n';
}
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export async function prepareFiles({ planPath, programs, out }) {
  const bytes = await readFile(planPath), input = JSON.parse(bytes);
  input.source = { ...input.source, preparedPlan: { file: basename(planPath), bytes: bytes.length, digest: digest(bytes) } };
  const plan = prepareShaderSourcePlan(input, programs), installer = shaderSourceInstaller();
  await mkdir(out);
  await writeFile(join(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  await writeFile(join(out, 'install.js'), installer);
  return { status: 'prepared', out, selectedPrograms: plan.selectedPrograms, planDigest: digest(JSON.stringify(plan)), installerDigest: digest(installer) };
}

/** Write reassembled source pages only after checking every advertised body. */
export async function exportSources(collected, out) {
  const { report, programs, draws, sources } = collected ?? {};
  if (!report || report.kind !== 'bounded-aligned-shader-sources' || !['complete', 'partial'].includes(report.status) || report.phase !== 'done' || report.methodsRestored !== true || report.restoreFailures !== 0 || report.retainedProgramHandles !== 0 || report.expectedOperations !== report.observedOperations) throw Error('collection must terminate with a fully matched frame and restored methods');
  if (!Array.isArray(programs) || programs.length !== report.expectedPrograms || !Array.isArray(draws) || draws.length !== report.observedDraws || draws.length !== report.expectedDraws || !Array.isArray(sources)) throw Error('incomplete collection metadata');
  const programByOrdinal = new Map(), workIndices = new Set();
  for (const program of programs) {
    if (!Number.isInteger(program?.ordinal) || program.ordinal < 1 || program.ordinal > programs.length || programByOrdinal.has(program.ordinal) || !Array.isArray(program.workIndices) || !Array.isArray(program.glEventIndices) || program.workIndices.length !== program.glEventIndices.length || !Array.isArray(program.shaders)) throw Error('invalid program metadata');
    programByOrdinal.set(program.ordinal, program);
  }
  for (const draw of draws) {
    const program = programByOrdinal.get(draw.programOrdinal), index = program?.workIndices.indexOf(draw.workIndex);
    if (!program || index < 0 || program.glEventIndices[index] !== draw.glEventIndex || workIndices.has(draw.workIndex)) throw Error('draw/program mapping changed during transfer');
    workIndices.add(draw.workIndex);
  }
  const bodyByKey = new Map(), files = [];
  for (const body of sources) {
    if (!Number.isInteger(body?.ordinal) || !['vertex', 'fragment'].includes(body.stage) || !['original', 'translated'].includes(body.kind) || typeof body.text !== 'string') throw Error('invalid source body');
    const key = [body.ordinal, body.stage, body.kind].join(':');
    if (bodyByKey.has(key)) throw Error('duplicate source body');
    bodyByKey.set(key, body.text);
  }
  let bytes = 0;
  for (const program of programs) for (const shader of program.shaders) for (const kind of ['original', 'translated']) {
    const metadata = shader[kind], key = [program.ordinal, shader.stage, kind].join(':');
    if (metadata?.availability !== 'available') continue;
    const text = bodyByKey.get(key);
    if (typeof text !== 'string' || text.length !== metadata.chars || Buffer.byteLength(text) !== metadata.utf8Bytes) throw Error('missing, truncated or changed source: ' + key);
    if (metadata.utf8Bytes > 2 * 1024 * 1024) throw Error('source-byte-limit');
    bytes += metadata.utf8Bytes;
    const file = 'program-' + String(program.ordinal).padStart(2, '0') + '.' + shader.stage + (kind === 'original' ? '.glsl' : '.translated.txt');
    files.push({ ordinal: program.ordinal, pipelineId: program.pipelineId, stage: shader.stage, kind, file, chars: text.length, bytes: metadata.utf8Bytes, digest: digest(Buffer.from(text)), text });
    bodyByKey.delete(key);
  }
  if (bodyByKey.size || bytes !== report.totalSourceBytes || bytes > 16 * 1024 * 1024) throw Error('source inventory/byte count differs from collection');
  const manifest = { report, programs, draws, files: files.map(({ text, ...metadata }) => metadata) };
  await mkdir(out);
  for (const file of files) await writeFile(join(out, file.file), file.text, { flag: 'wx' });
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { status: 'exported', out, files: files.length, bytes, collectionStatus: report.status };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { plan: { type: 'string' }, programs: { type: 'string' }, collected: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } } });
  const usage = 'node shader_sources.mjs --plan VERIFIED_OMISSION_PLAN_JSON [--programs 7,8,9,10,11] --out NEW_DIRECTORY\nnode shader_sources.mjs --collected REASSEMBLED_JSON --out NEW_DIRECTORY';
  if (values.help) console.log(usage);
  else {
    if (!values.out || Boolean(values.plan) === Boolean(values.collected) || values.collected && values.programs) throw Error(usage);
    console.log(JSON.stringify(values.collected ? await exportSources(JSON.parse(await readFile(values.collected, 'utf8')), values.out) :
      await prepareFiles({ planPath: values.plan, programs: values.programs?.split(',').map(Number), out: values.out })));
  }
}
