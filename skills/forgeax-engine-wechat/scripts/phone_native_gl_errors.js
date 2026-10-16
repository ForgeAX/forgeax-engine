/* Diagnostic observation only: original native calls and thrown values remain authoritative. */
export function redactDiagnosticText(value) {
  var redacted = 0;
  function omit() { redacted++; return '[redacted]'; }
  var text = value
    .replace(/\b(?:https?|wss?|file):\/\/[^\s<>()"']+/gi, omit)
    .replace(/\bBearer[ \t]+[^\s;,]+/gi, omit)
    .replace(/\bwx[0-9a-f]{16}\b/gi, omit)
    .replace(/\b(password|passwd|secret|token|access[_-]?token|refresh[_-]?token|authorization|cookie|input|inputValue|defaultValue|userInput)\b(["']?\s*[:=]\s*)(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s;,]+)/gi,
      function (_, key, delimiter) { redacted++; return key + delimiter + '[redacted]'; });
  return { text: text, redacted: redacted };
}

export function wasmCallerLines(stack) {
  return stack.split('\n').filter(function (line) {
    return /wasm:\/\/wasm\/[A-Za-z0-9_.-]+|wasm-function\[\d+\]/.test(line);
  }).join('\n');
}

export function observeNativeGlErrors(wx, canProbeFenceStatus, options) {
  options = options || {};
  var readSubmitDepth = options.readSubmitDepth;
  var limits = { maxCanvases: 4, maxContexts: 4, maxMethods: 256, maxProperties: 1024,
    maxPrototypeDepth: 8, maxFailures: 16, maxMessageChars: 2048,
    maxWasmStackChars: 8192, maxInspectedChars: 65536, maxFenceResults: 256, maxFenceValues: 8 };
  var report = { limits: limits, factory: { status: 'unavailable' }, canvases: [],
    contexts: [], laterThrows: 0, skippedCanvases: 0, skippedContexts: 0 };
  var releases = [], canvases = new WeakSet(), contexts = new WeakSet(), ended = false;
  var DiagnosticError = Error;
  var lifetime = options.lifetime === true && typeof readSubmitDepth === 'function';
  if (lifetime) report.lifetime = { qualification: 'diagnostic-only', boundary: 'synchronous-rhiwgpuqueue_submit',
    limits: { sampleIntervalMs: 1000, maxSamplesPerContext: 120 } };
  function increment(object, key) { object[key] = Math.min(Number.MAX_SAFE_INTEGER, object[key] + 1); }
  function fenceCounts() {
    return { fenceSync: { calls: 0, nonNull: 0, null: 0, other: 0, throws: 0 },
      deleteSync: { calls: 0, throws: 0 },
      getSyncParameter: { calls: 0, signaled: 0, unsignaled: 0, other: 0, throws: 0 },
      clientWaitSync: { calls: 0, alreadySignaled: 0, timeoutExpired: 0, conditionSatisfied: 0,
        waitFailed: 0, other: 0, throws: 0 } };
  }
  function startFenceLifetime(facts) {
    var timer, cancel;
    function sample() {
      var row = { at: Date.now() };
      for (var scope of ['insideSubmit', 'outsideSubmit', 'unknownSubmitDepth']) {
        row[scope] = {};
        for (var method in facts[scope]) row[scope][method] = Object.assign({}, facts[scope][method]);
      }
      if (facts.samples.length >= report.lifetime.limits.maxSamplesPerContext) {
        facts.samples.shift(); increment(facts, 'droppedSamples');
      }
      facts.samples.push(row);
    }
    releases.push(function () {
      if (facts.sampler !== 'sampling') return;
      facts.sampler = 'stopped';
      try { cancel(timer); } catch (ignored) { facts.sampler = 'cancel-failed'; }
    });
    try {
      sample();
      var schedule = globalThis.setTimeout;
      cancel = globalThis.clearTimeout;
      if (typeof schedule === 'function' && typeof cancel === 'function') {
        var tick = function () {
          if (ended) return;
          try { sample(); timer = schedule(tick, report.lifetime.limits.sampleIntervalMs); }
          catch (ignored) { facts.sampler = 'sample-failed'; }
        };
        timer = schedule(tick, report.lifetime.limits.sampleIntervalMs);
        facts.sampler = 'sampling';
      }
    } catch (ignored) { facts.sampler = 'sample-failed'; }
  }
  function beginFenceCall(facts, method, args) {
    if (ended || !facts || (method !== 'fenceSync' && method !== 'deleteSync' && method !== 'clientWaitSync' &&
        (method !== 'getSyncParameter' || args[1] !== 0x9114))) return;
    // Sample the numeric boundary at entry, before native reentry can change it.
    var scope = 'unknownSubmitDepth';
    try {
      var depth = readSubmitDepth();
      if (Number.isSafeInteger(depth) && depth >= 0) scope = depth > 0 ? 'insideSubmit' : 'outsideSubmit';
    } catch (ignored) { /* Unknown depth must not become an outside-submit claim. */ }
    var row = facts[scope][method];
    increment(row, 'calls');
    return row;
  }
  function finishFenceCall(method, row, result) {
    if (ended || !row || method === 'deleteSync') return;
    // Fixed bins only. No sync identity, pointer, arbitrary number or return
    // object is retained, and no additional native query/wait is performed.
    var key = 'other';
    if (method === 'fenceSync') key = result === null ? 'null' : result === undefined ? 'other' : 'nonNull';
    else if (method === 'getSyncParameter') key = result === 0x9119 ? 'signaled' : result === 0x9118 ? 'unsignaled' : 'other';
    else if (method === 'clientWaitSync') key = result === 0x911a ? 'alreadySignaled'
      : result === 0x911b ? 'timeoutExpired' : result === 0x911c ? 'conditionSatisfied' : result === 0x911d ? 'waitFailed' : 'other';
    increment(row, key);
  }
  function field(error, key) {
    if (key === 'message' && typeof error === 'string') return { status: 'data', value: error };
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return { status: 'unavailable' };
    for (var object = error, depth = 0; object && depth < limits.maxPrototypeDepth; depth++) {
      var descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'string'
        ? { status: 'data', value: descriptor.value } : { status: 'accessor-unavailable' };
      object = Object.getPrototypeOf(object);
    }
    return { status: 'unavailable' };
  }
  function retain(error, id, method) {
    if (ended) return;
    if (report.first) { report.laterThrows = Math.min(Number.MAX_SAFE_INTEGER, report.laterThrows + 1); return; }
    var first = report.first = { at: Date.now(), context: id, method: method };
    try {
      var message = field(error, 'message'), originalStack = field(error, 'stack');
      var rawMessage = message.value || '', caller = new DiagnosticError('native GL call threw').stack;
      var rawStack = typeof caller === 'string' ? caller : '';
      var text = redactDiagnosticText(rawMessage.slice(0, limits.maxInspectedChars));
      var stack = redactDiagnosticText(wasmCallerLines(rawStack.slice(0, limits.maxInspectedChars)));
      first.message = text.text.slice(0, limits.maxMessageChars);
      first.messageStatus = message.status;
      // This stack is taken inside the catch while the original WASM callers are
      // still active. It is deliberately not labeled as the thrown Error.stack.
      first.callerWasmStack = stack.text.slice(0, limits.maxWasmStackChars);
      first.originalStackStatus = originalStack.status;
      first.truncated = { message: text.text.length > limits.maxMessageChars,
        callerWasmStack: stack.text.length > limits.maxWasmStackChars,
        inspection: rawMessage.length > limits.maxInspectedChars || rawStack.length > limits.maxInspectedChars };
      first.redacted = text.redacted + stack.redacted;
    } catch (ignored) { first.observation = 'inspection-unavailable'; }
  }
  function install(object, key, original, make, status) {
    try {
      var descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && !('value' in descriptor)) { status('unavailable', 'accessor-unavailable'); return; }
      if (typeof original !== 'function') { status('unavailable', 'method-unavailable'); return; }
      var wrapper = make(original);
      var owned = descriptor ? Object.assign({}, descriptor, { value: wrapper })
        : { value: wrapper, configurable: true, writable: true, enumerable: false };
      Object.defineProperty(object, key, owned);
      status('installed');
      releases.push(function () {
        try {
          var current = Object.getOwnPropertyDescriptor(object, key);
          if (!current || current.value !== wrapper || current.writable !== owned.writable ||
              current.configurable !== owned.configurable || current.enumerable !== owned.enumerable) {
            status('replaced'); return;
          }
          if (descriptor) Object.defineProperty(object, key, descriptor);
          else delete object[key];
          status('restored');
        } catch (ignored) { status('restoreFailed'); }
      });
    } catch (ignored) { status('unavailable', 'property-write-failed'); }
  }
  function observeContext(gl) {
    if (ended || !gl || typeof gl !== 'object' || contexts.has(gl)) return;
    contexts.add(gl);
    if (report.contexts.length >= limits.maxContexts) { report.skippedContexts++; return; }
    var facts = { id: report.contexts.length + 1, discovery: 'complete', installed: 0,
      restored: 0, replaced: 0, restoreFailed: 0, unavailable: 0, failures: [], fenceResults: {} };
    report.contexts.push(facts);
    if (lifetime) {
      facts.lifetime = { insideSubmit: fenceCounts(), outsideSubmit: fenceCounts(), unknownSubmitDepth: fenceCounts(),
        samples: [], droppedSamples: 0, sampler: 'unavailable' };
      startFenceLifetime(facts.lifetime);
    }
    var nativeSyncStatus = fieldMethod(gl, 'getSyncParameter'), nativeWait = fieldMethod(gl, 'clientWaitSync');
    var lastFenceProbe = -Infinity, syncIds, nextSyncId = 0;
    if (typeof canProbeFenceStatus === 'function') {
      facts.fenceProbe = {
        intervention: 'query-clientWaitSync(0,0)-query on the same native sync after scene readiness',
        maxPairs: 8, delayMs: options.fenceProbeDelayMs || 0,
        minimumIntervalMs: options.fenceProbeIntervalMs || 100, pairs: [] };
      try { syncIds = new WeakMap(); } catch (ignored) { /* Identity is explicitly unavailable on restricted hosts. */ }
      releases.push(function () { syncIds = undefined; });
    }
    function status(method, state, reason) {
      facts[state]++;
      if (!reason && state === 'replaced') reason = 'owned-method-replaced';
      if (!reason && state === 'restoreFailed') reason = 'restore-failed';
      if (reason && facts.failures.length < limits.maxFailures) facts.failures.push({ method: method, reason: reason });
    }
    function retainFenceResult(method, args, value) {
      if (ended || (method !== 'clientWaitSync' && (method !== 'getSyncParameter' || args[1] !== 0x9114))) return;
      var row = facts.fenceResults[method] || (facts.fenceResults[method] = { observed: 0, values: [], overflow: 0 });
      if (row.observed >= limits.maxFenceResults) return;
      row.observed++;
      var type = value === null ? 'null' : typeof value;
      // Fixed GL fence results only: preserve numeric enums/booleans, never an
      // arbitrary string, object, sync handle, or any argument other than pname.
      var scalar = type === 'number' ? (Number.isFinite(value) ? value : 'non-finite')
        : type === 'boolean' ? value : undefined;
      var previous = row.values.find(function (item) { return item.type === type && item.value === scalar; });
      if (previous) previous.count++;
      else if (row.values.length < limits.maxFenceValues) row.values.push({ type: type, value: scalar, count: 1 });
      else row.overflow++;
    }
    function probeFenceStatus(method, args, value) {
      var probe = facts.fenceProbe;
      if (ended || !probe || method !== 'getSyncParameter' || args[1] !== 0x9114 ||
          value !== 0x9118 || probe.pairs.length >= probe.maxPairs || !canProbeFenceStatus()) return;
      var now = Date.now();
      if (now - lastFenceProbe < probe.minimumIntervalMs) return;
      lastFenceProbe = now;
      var pair = { at: now, before: { type: 'number', value: value } };
      probe.pairs.push(pair);
      try {
        var submitDepth = typeof readSubmitDepth === 'function' ? readSubmitDepth() : undefined;
        if (Number.isSafeInteger(submitDepth) && submitDepth >= 0) pair.submitDepth = submitDepth;
        else pair.submitDepthStatus = 'unavailable';
      } catch (ignored) { pair.submitDepthStatus = 'unavailable'; }
      // At most eight sampled keys, all weak. Only a local number reaches the
      // report; never retain a sync object or a native pointer between events.
      if (!args[0] || typeof args[0] !== 'object') pair.observationIdStatus = 'non-object';
      else if (!syncIds) pair.observationIdStatus = 'weakmap-unavailable';
      else {
        try {
          var id = syncIds.get(args[0]);
          if (id === undefined) { id = ++nextSyncId; syncIds.set(args[0], id); }
          pair.observationId = id;
        } catch (ignored) { pair.observationIdStatus = 'unavailable'; }
      }
      function scalar(result) {
        return { type: result === null ? 'null' : typeof result,
          value: typeof result === 'boolean' || (typeof result === 'number' && Number.isFinite(result)) ? result : undefined };
      }
      try {
        if (typeof nativeWait !== 'function' || typeof nativeSyncStatus !== 'function') {
          pair.status = 'native-method-unavailable'; return;
        }
        pair.wait = scalar(nativeWait.call(gl, args[0], 0, 0));
        pair.after = scalar(nativeSyncStatus.call(gl, args[0], 0x9114));
        pair.status = 'observed';
      } catch (ignored) { pair.status = 'native-probe-threw'; }
    }
    var seen = new Set(), properties = 0, methods = 0;
    for (var object = gl, depth = 0; object; object = Object.getPrototypeOf(object), depth++) {
      if (depth >= limits.maxPrototypeDepth) { facts.discovery = 'prototype-limit'; return; }
      if (depth > 0 && Object.getPrototypeOf(object) === null) return;
      var names = Object.getOwnPropertyNames(object);
      for (var i = 0; i < names.length; i++) {
        if (++properties > limits.maxProperties) { facts.discovery = 'property-limit'; return; }
        var key = names[i];
        if (seen.has(key) || key === 'constructor' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)) continue;
        seen.add(key);
        var descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !('value' in descriptor)) { status(key, 'unavailable', 'accessor-unavailable'); continue; }
        if (typeof descriptor.value !== 'function') continue;
        if (++methods > limits.maxMethods) { facts.discovery = 'method-limit'; return; }
        (function (method, original) {
          install(gl, method, original, function (call) {
            return function () {
              var fenceCall;
              if (lifetime) { try { fenceCall = beginFenceCall(facts.lifetime, method, arguments); } catch (ignored) {} }
              try {
                var result = call.apply(this, arguments);
                if (fenceCall) { try { finishFenceCall(method, fenceCall, result); } catch (ignored) {} }
                if (method === 'getSyncParameter' || method === 'clientWaitSync') {
                  try { retainFenceResult(method, arguments, result); } catch (ignored) { facts.fenceObservation = 'inspection-unavailable'; }
                  try { probeFenceStatus(method, arguments, result); } catch (ignored) { facts.fenceObservation = 'inspection-unavailable'; }
                }
                return result;
              }
              catch (error) {
                if (!ended && fenceCall) { try { increment(fenceCall, 'throws'); } catch (ignored) {} }
                try { retain(error, facts.id, method); } catch (ignored) {} throw error;
              }
            };
          }, function (state, reason) { status(method, state, reason); });
        })(key, descriptor.value);
      }
    }
  }
  function observeCanvas(canvas) {
    if (ended || !canvas || typeof canvas !== 'object' || canvases.has(canvas)) return;
    canvases.add(canvas);
    if (report.canvases.length >= limits.maxCanvases) { report.skippedCanvases++; return; }
    var facts = { status: 'unavailable' };
    report.canvases.push(facts);
    install(canvas, 'getContext', fieldMethod(canvas, 'getContext'), function (call) {
      return function () {
        var result = call.apply(this, arguments);
        if (arguments[0] === 'webgl2') {
          try { observeContext(result); } catch (ignored) { facts.observation = 'inspection-unavailable'; }
        }
        return result;
      };
    }, function (state, reason) { facts.status = state; if (reason) facts.reason = reason; });
  }
  function fieldMethod(object, key) {
    for (var depth = 0; object && depth < limits.maxPrototypeDepth; object = Object.getPrototypeOf(object), depth++) {
      var descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
    }
  }
  try {
    install(wx, 'createCanvas', fieldMethod(wx, 'createCanvas'), function (call) {
      return function () {
        var canvas = call.apply(this, arguments);
        try { observeCanvas(canvas); } catch (ignored) { report.factory.observation = 'inspection-unavailable'; }
        return canvas;
      };
    }, function (state, reason) { report.factory.status = state; if (reason) report.factory.reason = reason; });
  } catch (ignored) { report.factory.reason = 'inspection-unavailable'; }
  return { report: report, release: function () {
    if (ended) return;
    ended = true;
    for (var i = releases.length - 1; i >= 0; i--) releases[i]();
    releases.length = 0;
  } };
}
