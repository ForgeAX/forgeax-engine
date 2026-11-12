/* Diagnostic only: execute before the unchanged published game.js. */
;(function () {
  if (typeof wx === 'undefined') return;
  var options = __FORGEAX_PROBE_OPTIONS__;
  var showingFacts = !options.observeFrames && !options.observeGlLink;
  var firstFatal;
  var fatalShown = false;
  var frameFailure;
  function describe(error) {
    try {
      if (error && typeof error.stack === 'string') return error.stack;
      if (typeof error === 'string') return error;
      return JSON.stringify(error) || String(error);
    } catch (ignored) { return String(error); }
  }
  function showFatal() {
    if (options.observeFrames || options.observeGlLink || showingFacts || fatalShown || !firstFatal) return;
    fatalShown = true;
    wx.showModal({ title: 'ForgeAX first fatal', content: firstFatal.slice(0, 3500), showCancel: false });
  }
  function record(kind, error) {
    if (!firstFatal) firstFatal = kind + '\n' + describe(error);
    if (frameFailure) frameFailure(kind, describe(error));
    showFatal();
  }
  if (typeof wx.onError === 'function') wx.onError(function (error) { record('wx.onError', error); });
  if (typeof wx.onUnhandledRejection === 'function') wx.onUnhandledRejection(function (event) {
    record('wx.onUnhandledRejection', event && event.reason !== undefined ? event.reason : event);
  });
  if (typeof wx.setEnableDebug === 'function') {
    try { wx.setEnableDebug({ enableDebug: true }); }
    catch (error) { console.warn('[forgeax.phone.startup-probe]', describe(error)); }
  }
  var sdk = 'unavailable';
  if (typeof wx.getAppBaseInfo === 'function') {
    try { sdk = wx.getAppBaseInfo().SDKVersion; }
    catch (error) { sdk = describe(error); }
  }
  var facts = [
    'Publication: __FORGEAX_PROBE_MANIFEST__',
    'SDKVersion: ' + sdk,
    'globalThis: ' + typeof globalThis,
    'GameGlobal: ' + typeof GameGlobal,
    'TextEncoder: ' + typeof TextEncoder,
    'TextDecoder: ' + typeof TextDecoder,
    'WeakRef: ' + typeof WeakRef,
    'queueMicrotask: ' + typeof queueMicrotask
  ].join('\n');
  console.info('[forgeax.phone.startup-probe]', facts);
  if (!options.observeFrames) {
    if (options.observeGlLink) return;
    wx.showModal({
      title: 'ForgeAX native API facts', content: facts, showCancel: false,
      complete: function () { showingFacts = false; showFatal(); }
    });
    return;
  }

  var began = Date.now();
  var baseline;
  var previous;
  var previousTime = began;
  var done = false;
  var pollTimer;
  var startupTimer;
  var totalTimer;
  function finish(result) {
    if (done) return;
    done = true;
    frameFailure = undefined;
    clearTimeout(pollTimer);
    clearTimeout(startupTimer);
    clearTimeout(totalTimer);
    if (typeof wx.offHide === 'function') wx.offHide(hidden);
    result.kind = 'forgeax-phone-frame-observation';
    result.source = options.source;
    result.windowMs = options.windowMs;
    result.clock = 'Date.now';
    result.generation = baseline && baseline.generation;
    console.info('[forgeax.phone.frames]', JSON.stringify(result));
    if (options.showFrameResult && typeof wx.showModal === 'function') {
      wx.showModal({ title: 'ForgeAX frame observation', showCancel: false,
        content: result.phase === 'complete'
          ? 'Completed: ' + result.completedFps.toFixed(2) + ' FPS\nPresented: ' + result.presentedFps.toFixed(2)
            + ' FPS\nWindow: ' + result.elapsedMs + ' ms\nGeneration: ' + result.generation
          : 'Observation failed: ' + result.reason });
    }
  }
  function failed(reason, detail) { finish({ phase: 'failed', reason: reason, detail: detail }); }
  function hidden() { failed('host-hidden'); }
  frameFailure = function (kind, error) { failed(kind, error); };
  if (typeof wx.onHide === 'function') wx.onHide(hidden);
  startupTimer = setTimeout(function () { failed('startup-timeout'); }, options.deadlineMs - options.windowMs - 5000);
  totalTimer = setTimeout(function () { failed('observation-timeout'); }, options.deadlineMs);
  function poll() {
    if (done) return;
    try {
      var inspection = typeof globalThis === 'object' && globalThis.__forgeaxGameInspection;
      var state = inspection && typeof inspection.renderer === 'function' ? inspection.renderer() : undefined;
      var now = Date.now();
      if (now < previousTime) { failed('clock-regressed'); return; }
      previousTime = now;
      if (state && (state.startupError != null || state.lastError != null)) {
        failed('renderer-error', describe(state.startupError || state.lastError)); return;
      }
      if (state && ['failed', 'disposing', 'disposed', 'stopped'].indexOf(state.phase) !== -1) {
        failed('host-stopped', state.phase); return;
      }
      if (baseline && (!state || state.generation !== baseline.generation || inspection !== baseline.inspection)) {
        failed('generation-changed'); return;
      }
      if (baseline && (state.phase !== 'ready' || state.state !== 'alive')) {
        failed('scene-left-ready', state.phase); return;
      }
      if (state && state.phase === 'ready' && state.state === 'alive') {
        if (!Number.isSafeInteger(state.generation) || !Number.isSafeInteger(state.completed)
            || !Number.isSafeInteger(state.presented) || state.presented < 0 || state.completed < state.presented) {
          failed('invalid-frame-counters'); return;
        }
        if (previous && (state.completed < previous.completed || state.presented < previous.presented)) {
          failed('frame-counters-regressed'); return;
        }
        previous = { completed: state.completed, presented: state.presented };
        if (!baseline && state.presented > 0) {
          baseline = { inspection: inspection, generation: state.generation, time: now,
            completed: state.completed, presented: state.presented };
          clearTimeout(startupTimer);
        } else if (baseline && now - baseline.time >= options.windowMs) {
          var elapsed = now - baseline.time;
          var completedDelta = state.completed - baseline.completed;
          var presentedDelta = state.presented - baseline.presented;
          finish({ phase: 'complete', elapsedMs: elapsed, startupElapsedMs: baseline.time - began,
            completedStart: baseline.completed, completedEnd: state.completed, completedDelta: completedDelta,
            presentedStart: baseline.presented, presentedEnd: state.presented, presentedDelta: presentedDelta,
            completedFps: completedDelta * 1000 / elapsed, presentedFps: presentedDelta * 1000 / elapsed });
          return;
        }
      }
    } catch (error) { failed('inspection-failed', describe(error)); return; }
    pollTimer = setTimeout(poll, options.pollMs);
  }
  poll();
})();
