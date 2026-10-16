/* Diagnostic clone only: observe the real Host terminal state without changing it. */
import { persistPhoneReport, sendPhoneReport } from './phone_report_transport.js';
import { observeNativeGlErrors, redactDiagnosticText, wasmCallerLines } from './phone_native_gl_errors.js';
import { observeNativeWasmErrors } from './phone_native_wasm_errors.js';
import { utf8fromStringLoose } from '@exodus/bytes/utf8.js';

;(function () {
  if (typeof wx === 'undefined' || globalThis.__forgeaxPhoneStartupReport !== undefined) return;
  var options = __FORGEAX_PROBE_OPTIONS__;
  var report = { kind: 'forgeax-phone-startup', source: options.source,
    startedAt: Date.now(), transitions: [],
    sceneFrames: { minimum: options.minimumSceneFrames || 1, observed: 0, passed: false } };
  globalThis.__forgeaxPhoneStartupReport = report;
  var ended = false, timer, deadline, lastState, lastPhase, lastGeneration;
  var inspectionOwner, sceneOwner;
  var releases = [];
  var inspectionReads = (options.inspectionReads || []).map(function (id) { return { id: id, status: 'not-started' }; });
  var captureCapability, readsStarted = false, readContext;

  // console_error_panic_hook 0.1.7 emits one string: PanicInfo + "\n\nStack:\n\n"
  // + Error.stack. Capture it before RHI normalizes the thrown error to "unreachable".
  // Keep this separately bounded so a large renderer snapshot cannot evict the first panic.
  var rustPanics = report.rustPanics = { hook: 'unavailable',
    limits: { maxRecords: 16, maxTextChars: 2048, maxWasmStackChars: 16384,
      maxInspectedChars: 65536, maxTotalChars: 65536 },
    records: [], dropped: 0, retainedChars: 0 };
  function widenRustPanicStack() {
    var facts = rustPanics.stackTraceLimit = { requested: 64, status: 'unavailable' };
    var errorOwner, original;
    try {
      errorOwner = globalThis.Error;
      original = errorOwner && Object.getOwnPropertyDescriptor(errorOwner, 'stackTraceLimit');
    } catch (ignored) { facts.reason = 'property-read-failed'; return; }
    if (!original) { facts.reason = 'unsupported'; return; }
    // Never invoke an accessor or copy arbitrary values into the report.
    facts.original = { configurable: original.configurable, enumerable: original.enumerable };
    if (!('value' in original)) {
      facts.original.getter = typeof original.get;
      facts.original.setter = typeof original.set;
      facts.reason = 'accessor-unavailable'; return;
    }
    facts.original.writable = original.writable;
    if (typeof original.value !== 'number') {
      facts.original.valueType = typeof original.value;
      facts.reason = 'unsupported-value'; return;
    }
    facts.original.value = Number.isFinite(original.value) ? original.value : String(original.value);
    if (original.value >= facts.requested) {
      facts.effective = facts.original.value;
      facts.status = 'already-sufficient'; return;
    }
    if (!Number.isFinite(original.value) || original.value < 0) {
      facts.reason = 'unsupported-value'; return;
    }
    var owned = Object.assign({}, original, { value: facts.requested });
    try { Object.defineProperty(errorOwner, 'stackTraceLimit', owned); }
    catch (ignored) { facts.reason = 'property-write-failed'; return; }
    facts.status = 'installed';
    facts.effective = owned.value;
    releases.push(function () {
      try {
        var current = Object.getOwnPropertyDescriptor(errorOwner, 'stackTraceLimit');
        if (globalThis.Error !== errorOwner || !current || current.value !== owned.value ||
            current.writable !== owned.writable || current.configurable !== owned.configurable ||
            current.enumerable !== owned.enumerable) { facts.status = 'replaced'; return; }
        Object.defineProperty(errorOwner, 'stackTraceLimit', original);
        facts.status = 'restored';
      } catch (ignored) { facts.status = 'restore-failed'; }
    });
  }
  widenRustPanicStack();
  var nativeWasmErrors = observeNativeWasmErrors(typeof WXWebAssembly === 'undefined' ? undefined : WXWebAssembly,
    { lifetime: options.observeWasmLifetime === true, trackSubmitDepth: options.probeFenceStatus === true });
  report.nativeWasmErrors = nativeWasmErrors.report;
  releases.push(nativeWasmErrors.release);
  var nativeGlErrors = observeNativeGlErrors(wx, options.probeFenceStatus === true
    ? function () { return report.sceneFrames.observed > 0 && lastPhase === 'ready'
      && (!(options.fenceProbeDelayMs > 0)
        || Date.now() - report.sceneFrames.startedAt >= options.fenceProbeDelayMs); } : undefined,
    { lifetime: options.observeWasmLifetime === true, readSubmitDepth: nativeWasmErrors.submitDepth,
      fenceProbeDelayMs: options.fenceProbeDelayMs, fenceProbeIntervalMs: options.fenceProbeIntervalMs });
  report.nativeGlErrors = nativeGlErrors.report;
  releases.push(nativeGlErrors.release);
  function retainRustPanic(message) {
    if (ended || typeof message !== 'string' ||
        !/^(?:panicked at |thread '[^'\r\n]{0,128}' panicked at )/.test(message.slice(0, 160))) return;
    if (rustPanics.records.length >= rustPanics.limits.maxRecords ||
        rustPanics.retainedChars >= rustPanics.limits.maxTotalChars) {
      rustPanics.dropped = Math.min(Number.MAX_SAFE_INTEGER, rustPanics.dropped + 1);
      return;
    }
    var inspected = message.slice(0, rustPanics.limits.maxInspectedChars);
    var separator = inspected.indexOf('\n\nStack:\n\n');
    var textResult = redactDiagnosticText(separator < 0 ? inspected : inspected.slice(0, separator));
    var text = textResult.text;
    var stack = separator < 0 ? '' : inspected.slice(separator + '\n\nStack:\n\n'.length);
    // Preserve original WASM caller lines/offsets. JS stack URLs and all other
    // console arguments can contain app input or credentials and are never retained.
    var stackResult = redactDiagnosticText(wasmCallerLines(stack));
    var wasmStack = stackResult.text;
    var available = rustPanics.limits.maxTotalChars - rustPanics.retainedChars;
    var retainedText = text.slice(0, Math.min(rustPanics.limits.maxTextChars, available));
    var retainedStack = wasmStack.slice(0, Math.min(rustPanics.limits.maxWasmStackChars, available - retainedText.length));
    rustPanics.retainedChars += retainedText.length + retainedStack.length;
    rustPanics.records.push({ at: Date.now(), text: retainedText, wasmStack: retainedStack,
      truncated: { inspection: inspected.length < message.length,
        text: text.length > rustPanics.limits.maxTextChars,
        wasmStack: wasmStack.length > rustPanics.limits.maxWasmStackChars,
        total: retainedText.length < Math.min(text.length, rustPanics.limits.maxTextChars) ||
          retainedStack.length < Math.min(wasmStack.length, rustPanics.limits.maxWasmStackChars) },
      redacted: textResult.redacted + stackResult.redacted });
  }
  try {
    var consoleOwner = globalThis.console;
    var originalErrorDescriptor = consoleOwner && Object.getOwnPropertyDescriptor(consoleOwner, 'error');
    var originalError = originalErrorDescriptor && !('value' in originalErrorDescriptor)
      ? undefined : consoleOwner && consoleOwner.error;
    if (typeof originalError === 'function') {
      var observeRustPanic = function () {
        try { retainRustPanic(arguments[0]); } catch (ignored) { /* Preserve native console behavior. */ }
        return originalError.apply(this, arguments);
      };
      Object.defineProperty(consoleOwner, 'error', originalErrorDescriptor
        ? Object.assign({}, originalErrorDescriptor, { value: observeRustPanic })
        : { value: observeRustPanic, writable: true, configurable: true, enumerable: true });
      rustPanics.hook = 'installed';
      releases.push(function () {
        var current = Object.getOwnPropertyDescriptor(consoleOwner, 'error');
        if (!current || current.value !== observeRustPanic) { rustPanics.hook = 'replaced'; return; }
        try {
          if (originalErrorDescriptor) Object.defineProperty(consoleOwner, 'error', originalErrorDescriptor);
          else delete consoleOwner.error;
          rustPanics.hook = 'restored';
        } catch (ignored) { rustPanics.hook = 'restore-failed'; }
      });
    }
  } catch (ignored) { /* A restricted console remains an explicit unavailable observation. */ }

  function clockFacts() {
    function sample(object) {
      var facts = { type: typeof object };
      try {
        facts.nowType = object == null ? 'unavailable' : typeof object.now;
        if (facts.nowType === 'function') {
          var value = object.now();
          facts.sampleType = typeof value;
          facts.finite = typeof value === 'number' && Number.isFinite(value);
          if (facts.finite) facts.sample = value;
        }
      } catch (error) { facts.error = String(error && error.message || error); }
      return facts;
    }
    function realm(object) {
      var facts = { type: typeof object, sameAsGlobalThis: object === globalThis };
      try {
        if (object == null) return facts;
        var descriptor = Object.getOwnPropertyDescriptor(object, 'performance');
        facts.descriptor = descriptor ? { configurable: descriptor.configurable,
          enumerable: descriptor.enumerable, writable: descriptor.writable,
          getter: typeof descriptor.get, setter: typeof descriptor.set,
          valueType: typeof descriptor.value } : null;
        facts.performance = sample(object.performance);
      } catch (error) { facts.error = String(error && error.message || error); }
      return facts;
    }
    var facts = { globalThis: realm(globalThis), self: realm(typeof self === 'undefined' ? undefined : self),
      window: realm(typeof window === 'undefined' ? undefined : window),
      global: realm(typeof global === 'undefined' ? undefined : global),
      wxGetPerformanceType: typeof wx.getPerformance };
    try {
      if (typeof wx.getPerformance === 'function') facts.wechat = sample(wx.getPerformance());
    } catch (error) { facts.wechat = { error: String(error && error.message || error) }; }
    return facts;
  }
  report.clockBeforeStartup = clockFacts();
  report.stringOrdering = {
    upperLower: 'AlphaClip'.localeCompare('alphaClip'),
    underscoreLetter: '_'.localeCompare('a'),
    localeKeys: ['AlphaClip', 'alphaClip', '_', 'a'].sort(function (a, b) { return a.localeCompare(b); }),
    codeUnitKeys: ['AlphaClip', 'alphaClip', '_', 'a'].sort()
  };

  // Error.cause, stack and message are often non-enumerable. Read data descriptors
  // instead of JSON.stringify(Error) or invoking application getters/toJSON.
  function snapshot(value) {
    var limits = { maxDepth: 24, maxNodes: 4096, maxProperties: 256,
      maxStringChars: 65536, maxTotalChars: 262144 };
    var nodes = 0, chars = 0, ancestors = [], issues = [];
    function marker(reason, path, extra) {
      if (issues.length < 32) issues.push({ reason: reason, path: path });
      return Object.assign({ $forgeaxDiagnostic: reason }, extra);
    }
    function visit(input, path, depth) {
      if (++nodes > limits.maxNodes) return marker('node-limit', path);
      if (input === null || typeof input === 'boolean') return input;
      if (typeof input === 'number') return Number.isFinite(input) ? input : marker('non-finite', path, { value: String(input) });
      if (typeof input === 'string') {
        var allowed = Math.max(0, Math.min(limits.maxStringChars, limits.maxTotalChars - chars));
        chars += Math.min(input.length, allowed);
        return input.length <= allowed ? input : marker('string-limit', path, { length: input.length, prefix: input.slice(0, allowed) });
      }
      if (typeof input !== 'object') return marker(typeof input, path);
      if (depth >= limits.maxDepth) return marker('depth-limit', path);
      if (ancestors.indexOf(input) !== -1) return marker('cycle', path);
      ancestors.push(input);
      try {
        var array = Array.isArray(input), result = array ? [] : Object.create(null);
        var names = Object.getOwnPropertyNames(input);
        // Prefer ownership and causal fields when the object reaches its bound.
        var priority = ['name', 'message', 'stack', 'code', 'expected', 'hint', 'cause', 'detail', 'errors'];
        var keys = array ? names.filter(function (key) { return key !== 'length'; })
          : priority.filter(function (key) { return names.indexOf(key) !== -1; }).concat(names.filter(function (key) { return priority.indexOf(key) === -1; }));
        if (!array && names.indexOf('name') === -1) {
          var prototype = Object.getPrototypeOf(input), level = 0;
          while (prototype && level++ < 4) {
            var name = Object.getOwnPropertyDescriptor(prototype, 'name');
            if (name && 'value' in name && typeof name.value === 'string') { result.name = visit(name.value, path + '.name', depth + 1); break; }
            prototype = Object.getPrototypeOf(prototype);
          }
        }
        for (var i = 0; i < keys.length; i++) {
          if (i >= limits.maxProperties || nodes >= limits.maxNodes || chars >= limits.maxTotalChars) {
            var remainder = marker('object-limit', path, { omittedProperties: keys.length - i });
            if (array) result.push(remainder); else result.$forgeaxRemaining = remainder;
            break;
          }
          var key = keys[i];
          if (key.length > 256) {
            var omitted = marker('key-limit', path, { keyLength: key.length });
            if (array) result.push(omitted); else result.$forgeaxKey = omitted;
            continue;
          }
          chars += key.length;
          var descriptor = Object.getOwnPropertyDescriptor(input, key);
          var item = descriptor && 'value' in descriptor
            ? visit(descriptor.value, path + '.' + key, depth + 1)
            : marker('accessor-unavailable', path + '.' + key);
          // Array custom properties are unusual; preserve their names explicitly.
          if (array) result.push(/^\d+$/.test(key) ? item : { property: key, value: item });
          else result[key] = item;
        }
        return result;
      } catch (ignored) { return marker('inspection-unavailable', path); }
      finally { ancestors.pop(); }
    }
    var result = visit(value, '$', 0);
    return { value: result, serialization: { limits: limits, nodes: nodes, chars: chars, issues: issues } };
  }
  function read() {
    var inspection = globalThis.__forgeaxGameInspection;
    inspectionOwner = inspection;
    return inspection && typeof inspection.renderer === 'function' ? inspection.renderer() : undefined;
  }
  function startInspectionReads(owner) {
    readsStarted = true;
    if (inspectionReads.length === 0) return;
    readContext = { requestedAt: Date.now(), generation: lastState.generation,
      afterCompletion: Object.assign({}, lastState.lastCompletion) };
    try {
      captureCapability = owner.rhiCapture && typeof owner.rhiCapture.captureFrame === 'function'
        ? { available: true } : { available: false, reason: 'recorder-not-enabled' };
    } catch (error) { captureCapability = { available: false, reason: 'inspection-failed', error: error }; }
    inspectionReads.forEach(function (row) {
      row.status = 'pending';
      var timeout = setTimeout(function () {
        if (!ended && row.status === 'pending') row.status = 'timed-out';
      }, 5000);
      releases.push(function () { clearTimeout(timeout); });
      function settle(status, value) {
        if (ended || row.status !== 'pending') return;
        clearTimeout(timeout);
        row.status = status;
        row.finishedAt = Date.now();
        if (status === 'fulfilled') row.value = value;
        else row.error = value;
      }
      try {
        if (typeof owner.read !== 'function') { settle('unavailable'); return; }
        Promise.resolve(owner.read(row.id)).then(function (value) { settle('fulfilled', value); },
          function (error) { settle('failed', error); });
      } catch (error) { settle('failed', error); }
    });
  }
  function boundLifetimeSamples() {
    if (options.observeWasmLifetime !== true) return;
    // The startup receiver admits 2 MiB. Keep original errors and final counters;
    // only time-series history yields when their combined UTF-8 report is larger.
    var facts = report.lifetimeSerialization = { maxBytes: 2 * 1024 * 1024,
      droppedSamples: 0, status: 'within-limit' };
    var series = nativeWasmErrors.report.instances.concat(nativeGlErrors.report.contexts)
      .map(function (row) { return row.lifetime; }).filter(function (row) { return !!row; });
    while (utf8fromStringLoose(JSON.stringify(report)).length > facts.maxBytes) {
      var removed = 0;
      for (var i = 0; i < series.length; i++) {
        var row = series[i], count = Math.ceil((row.samples.length - 1) / 2);
        if (count <= 0) continue;
        row.samples.splice(0, count);
        row.droppedSamples = Math.min(Number.MAX_SAFE_INTEGER, row.droppedSamples + count);
        removed += count;
      }
      if (!removed) { facts.status = 'over-limit'; return; }
      facts.droppedSamples += removed;
      facts.status = 'trimmed';
    }
  }
  function finish(reason, event) {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    for (var i = releases.length - 1; i >= 0; i--) {
      try { releases[i](); } catch (ignored) { /* Only owned observation callbacks are removed. */ }
    }
    var captured = snapshot(Object.assign({ renderer: lastState, event: event },
      inspectionReads.length ? { reads: inspectionReads, readContext: readContext, capture: captureCapability } : {}));
    report.reason = reason;
    report.finishedAt = Date.now();
    report.clockAtTerminal = clockFacts();
    report.observation = captured.value;
    report.serialization = captured.serialization;
    try { boundLifetimeSamples(); }
    catch (ignored) {
      if (report.lifetimeSerialization) report.lifetimeSerialization.status = 'serialization-failed';
    }
    try { console.info('[forgeax.phone.startup]', JSON.stringify(report)); }
    catch (ignored) { /* Native error propagation remains untouched. */ }
    sendPhoneReport(wx, options, report, persistPhoneReport(wx, report, 'startup'), 'startup');
  }
  function nativeFailure(kind, error) {
    try { lastState = read(); } catch (ignored) { /* Keep the original native error. */ }
    finish(kind, error);
  }
  function onError(error) { nativeFailure('wx.onError', error); }
  function onRejection(event) { nativeFailure('wx.onUnhandledRejection', event); }
  function onHide() { finish('host-hidden'); }
  function observe(on, off, callback) {
    // Without symmetric removal, retain no permanent callback in the game.
    if (typeof wx[on] !== 'function' || typeof wx[off] !== 'function') return;
    try {
      wx[on](callback);
      releases.push(function () { wx[off](callback); });
    } catch (ignored) { /* Polling is still available when native events are not. */ }
  }
  observe('onError', 'offError', onError);
  observe('onUnhandledRejection', 'offUnhandledRejection', onRejection);
  observe('onHide', 'offHide', onHide);
  deadline = setTimeout(function () { finish(lastState === undefined ? 'inspection-unavailable' : 'deadline'); }, options.deadlineMs);
  function poll() {
    if (ended) return;
    try {
      lastState = read();
      if (sceneOwner && (!lastState || inspectionOwner !== sceneOwner ||
          lastState.generation !== report.sceneFrames.generation ||
          lastState.frame && lastState.frame.deviceGeneration !== report.sceneFrames.deviceGeneration)) {
        finish('generation-changed'); return;
      }
      if (lastState) {
        if (lastState.phase !== lastPhase || lastState.generation !== lastGeneration) {
          if (report.transitions.length < 64) report.transitions.push({ at: Date.now(), phase: lastState.phase, generation: lastState.generation });
          lastPhase = lastState.phase;
          lastGeneration = lastState.generation;
        }
        if (lastState.startupError != null || lastState.lastError != null || lastState.phase === 'failed') { finish('startup-failed'); return; }
        if (['disposing', 'disposed', 'stopped'].indexOf(lastState.phase) !== -1) { finish('host-stopped'); return; }
        if (sceneOwner && (lastState.phase !== 'ready' || lastState.state !== 'alive')) {
          finish('scene-left-ready'); return;
        }
        if (lastState.phase === 'ready' && lastState.state === 'alive') {
          var frame = lastState.frame, receipt = lastState.lastCompletion, frames = report.sceneFrames;
          if (!Number.isSafeInteger(lastState.generation) || lastState.generation < 1 ||
              !Number.isSafeInteger(lastState.completed) || !Number.isSafeInteger(lastState.presented) ||
              lastState.presented < 0 || lastState.completed < lastState.presented ||
              !frame || !Number.isSafeInteger(frame.deviceGeneration) || frame.deviceGeneration < 0 ||
              lastState.completed > 0 && (!receipt || !Number.isSafeInteger(receipt.frameId) || receipt.frameId < 1 ||
                receipt.deviceGeneration !== frame.deviceGeneration)) {
            finish('invalid-frame-counters'); return;
          }
          if (!sceneOwner) {
            sceneOwner = inspectionOwner;
            frames.generation = lastState.generation;
            frames.deviceGeneration = frame.deviceGeneration;
            frames.startedAt = Date.now();
            frames.completedStart = lastState.completed;
            frames.presentedStart = lastState.presented;
          } else if (lastState.completed < frames.completedEnd || lastState.presented < frames.presentedEnd) {
            finish('frame-counters-regressed'); return;
          }
          frames.completedEnd = lastState.completed;
          frames.presentedEnd = lastState.presented;
          // The real Host increments presented only from completed scene-ready receipts.
          // Differences exclude earlier receipts and never count polls or loading/UI work.
          frames.observed = frames.presentedEnd - frames.presentedStart;
          if (frames.observed >= frames.minimum && receipt && receipt.presentation === 'ready') {
            if (!readsStarted) startInspectionReads(sceneOwner);
            if (!inspectionReads.some(function (row) { return row.status === 'pending'; })) {
              frames.passed = true;
              finish('scene-presented'); return;
            }
          }
        }
      }
    } catch (error) { finish('inspection-failed', error); return; }
    timer = setTimeout(poll, options.pollMs);
  }
  poll();
})();
