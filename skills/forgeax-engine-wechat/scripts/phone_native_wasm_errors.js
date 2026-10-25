import { redactDiagnosticText } from './phone_native_gl_errors.js';

// Diagnostic clone only. The native initializer consumes { instance.exports, module };
// project that one bridge instead of mutating immutable native WASM exports.
export function observeNativeWasmErrors(owner, options) {
  var limits = { maxInstances: 2, maxExports: 256, maxExportNameChars: 512, maxFailures: 16,
    maxMessageChars: 2048, maxStackChars: 16384, maxInspectedChars: 65536 };
  var report = { limits: limits, factory: { status: 'unavailable' }, instances: [],
    laterThrows: 0, skippedInstances: 0 };
  var releases = [], ended = false, stackGetter, activeSubmitDepth = 0;
  var lifetime = options && options.lifetime === true;
  var onInstantiate = options && options.onInstantiate;
  function notify(path, stage) {
    if (ended || typeof onInstantiate !== 'function' || typeof path !== 'string') return;
    try { onInstantiate(path, stage); } catch (ignored) { /* Observation preserves native outcomes. */ }
  }
  var trackSubmitDepth = lifetime || options && options.trackSubmitDepth === true;
  if (lifetime) {
    report.lifetime = { qualification: 'diagnostic-only',
      limits: { sampleIntervalMs: 1000, maxSamplesPerInstance: 600 },
      finalizationRegistry: { type: 'unavailable' } };
    try {
      var finalizer = descriptor(globalThis, 'FinalizationRegistry');
      report.lifetime.finalizationRegistry.type = !finalizer ? 'undefined'
        : 'value' in finalizer ? typeof finalizer.value : 'accessor-unavailable';
    } catch (ignored) { /* Capability discovery never constructs a registry. */ }
  }
  try {
    var stackDescriptor = Object.getOwnPropertyDescriptor(new Error(), 'stack');
    if (stackDescriptor && typeof stackDescriptor.get === 'function') stackGetter = stackDescriptor.get;
  } catch (ignored) {}
  function descriptor(object, key) {
    for (var depth = 0; object && depth < 8; object = Object.getPrototypeOf(object), depth++) {
      var found = Object.getOwnPropertyDescriptor(object, key);
      if (found) return found;
    }
  }
  function field(error, key) {
    if (key === 'message' && typeof error === 'string') return { status: 'data', value: error };
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return { status: 'unavailable' };
    var found = descriptor(error, key);
    if (!found) return { status: 'unavailable' };
    if ('value' in found) return typeof found.value === 'string'
      ? { status: 'data', value: found.value } : { status: 'non-string' };
    // V8 uses an own native accessor for Error/RuntimeError.stack. Compare the
    // actual getter identity; never run an arbitrary thrown object's accessor.
    if (key === 'stack' && stackGetter && found.get === stackGetter) {
      try {
        var value = stackGetter.call(error);
        return typeof value === 'string' ? { status: 'native-error-accessor', value: value }
          : { status: 'non-string' };
      } catch (ignored) { return { status: 'native-stack-read-failed' }; }
    }
    return { status: 'accessor-unavailable' };
  }
  function memoryFact(memory) {
    try {
      if (!memory) return { status: 'unavailable' };
      // Only the admitted native memory is sampled. Its declared maximum and
      // live allocation size are not exposed by this host API.
      var bytes = memory.buffer.byteLength;
      return Number.isSafeInteger(bytes) && bytes >= 0
        ? { status: 'available', byteLength: bytes, maximumStatus: 'not-exposed' }
        : { status: 'invalid-byte-length' };
    } catch (ignored) { return { status: 'read-failed' }; }
  }
  function increment(object, key) { object[key] = Math.min(Number.MAX_SAFE_INTEGER, object[key] + 1); }
  function operationKind(name) {
    if (/^__wbg_[A-Za-z0-9_]+_free$/.test(name)) return 'free';
    if (!/^rhiwgpu[a-z0-9]+_/.test(name)) return;
    var operation = name.slice(name.indexOf('_') + 1);
    if (/^create(?:[A-Z][A-Za-z0-9]*)?$/.test(operation)) return 'create';
    if (operation === 'beginRenderPass' || operation === 'beginComputePass') return 'begin';
    if (operation === 'finish' || operation === 'end' || operation === 'submit' || operation === 'destroy') return operation;
  }
  function countCall(row, args) {
    increment(row, 'calls');
    if (!row.freeArguments) return;
    // wasm-bindgen glue passes (ptr, 0) for explicit free and (ptr, 1) for
    // finalizers. Keep only bins: no pointer identities, coercion or arg retention.
    var free = row.freeArguments;
    increment(free, args.length < 2 ? 'missing' : args[1] === 0 ? 'explicit' : args[1] === 1 ? 'finalizer' : 'other');
    // The same wasm32 address may cross the glue as signed i32 or unsigned u32.
    increment(free, args[0] === 0 ? 'ptrZero'
      : Number.isInteger(args[0]) && args[0] >= -0x80000000 && args[0] <= 0xffffffff ? 'ptrNonzero' : 'ptrOther');
  }
  function sampleMemory(facts, memory) {
    var calls = { create: 0, begin: 0, finish: 0, end: 0, submit: 0, destroy: 0, free: 0 };
    var frees = { explicit: 0, finalizer: 0, missing: 0, other: 0 };
    for (var i = 0; i < facts.exports.length; i++) {
      var row = facts.exports[i];
      calls[row.kind] = Math.min(Number.MAX_SAFE_INTEGER, calls[row.kind] + row.calls);
      if (row.freeArguments) for (var key in frees) {
        frees[key] = Math.min(Number.MAX_SAFE_INTEGER, frees[key] + row.freeArguments[key]);
      }
    }
    var sample = { at: Date.now(), memory: memoryFact(memory), calls: calls, frees: frees };
    if (facts.samples.length >= report.lifetime.limits.maxSamplesPerInstance) {
      facts.samples.shift(); increment(facts, 'droppedSamples');
    }
    facts.samples.push(sample);
  }
  function retain(error, operation, instance, memory) {
    if (ended) return;
    if (report.first) { report.laterThrows = Math.min(Number.MAX_SAFE_INTEGER, report.laterThrows + 1); return; }
    var first = report.first = { at: Date.now(), operation: operation, instance: instance,
      memory: memoryFact(memory) };
    try {
      var message = field(error, 'message'), stack = field(error, 'stack');
      var rawMessage = message.value || '', rawStack = stack.value || '';
      var text = redactDiagnosticText(rawMessage.slice(0, limits.maxInspectedChars));
      var frames = redactDiagnosticText(rawStack.slice(0, limits.maxInspectedChars));
      first.message = text.text.slice(0, limits.maxMessageChars);
      first.messageStatus = message.status;
      first.stack = frames.text.slice(0, limits.maxStackChars);
      first.stackStatus = stack.status;
      first.truncated = { message: text.text.length > limits.maxMessageChars,
        stack: frames.text.length > limits.maxStackChars,
        inspection: rawMessage.length > limits.maxInspectedChars || rawStack.length > limits.maxInspectedChars };
      first.redacted = text.redacted + frames.redacted;
    } catch (ignored) { first.observation = 'inspection-unavailable'; }
  }
  function project(result) {
    if (ended) return result;
    if (report.instances.length >= limits.maxInstances) { report.skippedInstances++; return result; }
    var facts = { id: report.instances.length + 1, status: 'unavailable',
      installed: 0, restored: 0, replaced: 0, restoreFailed: 0, failures: [] };
    report.instances.push(facts);
    try {
      var exports = result.instance.exports;
      var names = Object.getOwnPropertyNames(exports);
      if (names.length > limits.maxExports) { facts.reason = 'export-limit'; return result; }
      // This exact native initializer is the only supported projection consumer.
      if (typeof exports.rhiwgpuqueue_writeBuffer !== 'function' ||
          typeof exports.rhiwgpuqueue_submit !== 'function') {
        facts.reason = 'wgpu-export-identity-unavailable'; return result;
      }
      var memory = exports.memory;
      facts.initialMemory = memoryFact(memory);
      var lifetimeFacts = lifetime ? { exports: [], samples: [], droppedSamples: 0, sampler: 'unavailable' } : undefined;
      var projected = Object.create(null), restorations = [];
      for (var i = 0; i < names.length; i++) {
        var name = names[i], original = Object.getOwnPropertyDescriptor(exports, name);
        if (!original || !('value' in original)) { facts.reason = 'export-accessor-unavailable'; return result; }
        if (name.length > limits.maxExportNameChars || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          facts.reason = 'export-name-unavailable'; return result;
        }
        var value = original.value;
        if (typeof value === 'function') {
          (function (key, call, enumerable) {
            var kind = lifetime && operationKind(key), counter;
            if (kind) {
              counter = { name: key, kind: kind, calls: 0, throws: 0 };
              if (kind === 'free') counter.freeArguments = { explicit: 0, finalizer: 0, missing: 0, other: 0,
                ptrZero: 0, ptrNonzero: 0, ptrOther: 0 };
              lifetimeFacts.exports.push(counter);
            }
            var wrapper = function () {
              if (!ended && counter) { try { countCall(counter, arguments); } catch (ignored) {} }
              var submitting = !ended && trackSubmitDepth && key === 'rhiwgpuqueue_submit';
              var previousDepth = activeSubmitDepth;
              if (submitting) activeSubmitDepth++;
              // Counts are entry attempts and synchronous throws, never success:
              // Result::Err/Promise returns stay opaque and are not inspected.
              try { return call.apply(this, arguments); }
              catch (error) {
                if (!ended && counter) { try { increment(counter, 'throws'); } catch (ignored) {} }
                try { retain(error, key, facts.id, memory); } catch (ignored) {} throw error;
              }
              finally { if (submitting) activeSubmitDepth = ended ? 0 : previousDepth; }
            };
            Object.defineProperty(projected, key, { value: wrapper, writable: true, configurable: true,
              enumerable: enumerable });
            restorations.push(function () {
              try {
                var current = Object.getOwnPropertyDescriptor(projected, key);
                if (!current || current.value !== wrapper || !current.writable || !current.configurable ||
                    current.enumerable !== enumerable) {
                  facts.replaced++;
                  if (facts.failures.length < limits.maxFailures) facts.failures.push({ method: key, reason: 'owned-method-replaced' });
                  return;
                }
                Object.defineProperty(projected, key, Object.assign({}, current, { value: call }));
                facts.restored++;
              } catch (ignored) {
                facts.restoreFailed++;
                if (facts.failures.length < limits.maxFailures) facts.failures.push({ method: key, reason: 'restore-failed' });
              }
            });
          })(name, value, original.enumerable);
        } else Object.defineProperty(projected, name, original);
      }
      // Native memory, table, global and module objects keep their exact identity.
      var facade = { instance: { exports: projected }, module: result.module };
      facts.installed = restorations.length;
      facts.status = 'projected';
      var timer, cancel;
      releases.push(function () {
        if (lifetimeFacts && lifetimeFacts.sampler === 'sampling') {
          lifetimeFacts.sampler = 'stopped';
          try { cancel(timer); } catch (ignored) { lifetimeFacts.sampler = 'cancel-failed'; }
        }
        memory = undefined;
        for (var j = restorations.length - 1; j >= 0; j--) restorations[j]();
        restorations.length = 0;
      });
      if (lifetimeFacts) {
        facts.lifetime = lifetimeFacts;
        try {
          sampleMemory(lifetimeFacts, memory);
          var schedule = globalThis.setTimeout;
          cancel = globalThis.clearTimeout;
          if (typeof schedule === 'function' && typeof cancel === 'function') {
            var sample = function () {
              if (ended) return;
              try {
                sampleMemory(lifetimeFacts, memory);
                timer = schedule(sample, report.lifetime.limits.sampleIntervalMs);
              } catch (ignored) { lifetimeFacts.sampler = 'sample-failed'; }
            };
            timer = schedule(sample, report.lifetime.limits.sampleIntervalMs);
            lifetimeFacts.sampler = 'sampling';
          }
        } catch (ignored) { lifetimeFacts.sampler = 'sample-failed'; }
      }
      return facade;
    } catch (ignored) { facts.reason = 'instance-inspection-failed'; return result; }
  }
  try {
    var method = descriptor(owner, 'instantiate');
    if (!method || !('value' in method) || typeof method.value !== 'function') {
      report.factory.reason = 'method-unavailable';
    } else {
      var original = Object.getOwnPropertyDescriptor(owner, 'instantiate'), call = method.value;
      var wrapper = function () {
        if (ended) return call.apply(this, arguments);
        var path = arguments[0];
        var matches = false;
        try {
          var imports = arguments[1], namespace = imports && Object.getOwnPropertyDescriptor(imports, './wgpu_wasm_bg.js');
          matches = !!(namespace && 'value' in namespace && namespace.value && typeof namespace.value === 'object');
        } catch (ignored) {}
        notify(path, 'load');
        var result;
        try { result = call.apply(this, arguments); }
        catch (error) {
          notify(path, 'failed');
          if (matches) { try { retain(error, 'instantiate', 0); } catch (ignored) {} }
          throw error;
        }
        if (!matches) {
          if (typeof onInstantiate === 'function') {
            Promise.resolve(result).then(function () { notify(path, 'done'); }, function () { notify(path, 'failed'); });
          }
          return result;
        }
        // WXWebAssembly.instantiate is an asynchronous host contract. Leave its
        // rejection and native thrown values authoritative.
        return result.then(function (value) { notify(path, 'done'); return project(value); }, function (error) {
          notify(path, 'failed');
          try { retain(error, 'instantiate', 0); } catch (ignored) {} throw error;
        });
      };
      var owned = original ? Object.assign({}, original, { value: wrapper })
        : { value: wrapper, configurable: true, writable: true, enumerable: false };
      Object.defineProperty(owner, 'instantiate', owned);
      report.factory.status = 'installed';
      releases.unshift(function () {
        try {
          var current = Object.getOwnPropertyDescriptor(owner, 'instantiate');
          if (!current || current.value !== wrapper || current.writable !== owned.writable ||
              current.configurable !== owned.configurable || current.enumerable !== owned.enumerable) {
            report.factory.status = 'replaced'; return;
          }
          if (original) Object.defineProperty(owner, 'instantiate', original);
          else delete owner.instantiate;
          report.factory.status = 'restored';
        } catch (ignored) { report.factory.status = 'restore-failed'; }
      });
    }
  } catch (ignored) { report.factory.reason = 'property-install-failed'; }
  return { report: report, submitDepth: function () { return activeSubmitDepth; }, release: function () {
    if (ended) return;
    ended = true;
    activeSubmitDepth = 0;
    for (var i = releases.length - 1; i >= 0; i--) releases[i]();
    releases.length = 0;
  } };
}
