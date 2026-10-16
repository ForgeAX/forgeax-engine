/* Diagnostic clone only. Observe the original native calls; never normalize results. */
import { utf8fromStringLoose } from '@exodus/bytes/utf8.js';
import { digest, persistPhoneReport, sendPhoneReport } from './phone_report_transport.js';
;(function () {
  if (typeof wx === 'undefined') return;
  var options = __FORGEAX_PROBE_OPTIONS__;
  if (globalThis.__forgeaxPhoneGlLinkReport !== undefined) {
    console.info('[forgeax.phone.gl-link]', JSON.stringify({ phase: 'install-failed', reason: 'existing-report' }));
    return;
  }
  var report = { kind: 'forgeax-phone-gl-link', source: options.source,
    startedAt: Date.now(), records: [], sources: [] };
  globalThis.__forgeaxPhoneGlLinkReport = report;
  var sourceBytes = 0;
  var sourceLimit = 2 * 1024 * 1024;
  var totalSourceLimit = 16 * 1024 * 1024;
  var releases = [];
  var canvases = new WeakSet();
  var contexts = new WeakSet();
  var contextCount = 0;
  var linkCount = 0;
  var ended = false;
  var timer;
  function message(error) {
    try { return String(error && error.message !== undefined ? error.message : error); }
    catch (ignored) { return 'unreadable error'; }
  }
  function emit(row) {
    try {
      row.kind = 'forgeax-phone-gl-link';
      row.source = options.source;
      report.records.push(row);
      console.info('[forgeax.phone.gl-link]', JSON.stringify(row));
    } catch (ignored) { /* Observation must not change the original call. */ }
  }
  function finish(reason) {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    for (var i = releases.length - 1; i >= 0; i--) releases[i]();
    releases.length = 0;
    emit({ phase: 'finished', reason: reason, contexts: contextCount, links: linkCount });
    report.reason = reason;
    report.finishedAt = Date.now();
    sendPhoneReport(wx, options, report, persistPhoneReport(wx, report, 'gl-link'), 'gl-link');
  }
  function install(object, key, make, owner) {
    try {
      var descriptor = Object.getOwnPropertyDescriptor(object, key);
      var original = object[key];
      if (typeof original !== 'function') throw new Error('method unavailable');
      if (descriptor && (!('value' in descriptor) || !descriptor.writable))
        throw new Error('method is not a writable data property');
      var wrapper = make(original);
      Object.defineProperty(object, key, descriptor
        ? Object.assign({}, descriptor, { value: wrapper })
        : { value: wrapper, configurable: true, writable: true, enumerable: false });
      if (object[key] !== wrapper) throw new Error('method replacement was not retained');
      releases.push(function () {
        try {
          if (object[key] !== wrapper) {
            emit({ phase: 'restore-skipped', owner: owner, method: key });
          } else if (descriptor) Object.defineProperty(object, key, descriptor);
          else delete object[key];
        } catch (error) { emit({ phase: 'restore-failed', owner: owner, method: key, error: message(error) }); }
      });
      emit({ phase: 'hook-installed', owner: owner, method: key });
      return true;
    } catch (error) {
      emit({ phase: 'hook-failed', owner: owner, method: key, error: message(error) });
      return false;
    }
  }
  function raw(value) {
    var type = typeof value;
    return { type: type, value: value === null || type === 'boolean' || type === 'string'
      || (type === 'number' && Number.isFinite(value)) ? value : String(value) };
  }
  function query(read) {
    try { return raw(read()); }
    catch (error) { return { error: message(error) }; }
  }
  function info(read) {
    var result = query(read);
    if (typeof result.value === 'string' && result.value.length > 65536) {
      result.length = result.value.length;
      result.value = result.value.slice(0, 65536);
      result.truncated = true;
    }
    return result;
  }
  function shaderSource(gl, shader) {
    try {
      var source = gl.getShaderSource(shader);
      if (typeof source !== 'string') return { availability: 'unavailable', result: raw(source) };
      if (source.length > sourceLimit) return { availability: 'over-limit', chars: source.length, maxBytes: sourceLimit };
      var bytes = utf8fromStringLoose(source);
      if (bytes.length > sourceLimit) return { availability: 'over-limit', bytes: bytes.length, maxBytes: sourceLimit };
      var hash = digest(bytes);
      var existing = report.sources.some(function (entry) { return entry.sha256 === hash; });
      if (!existing) {
        if (sourceBytes + bytes.length > totalSourceLimit)
          return { availability: 'over-limit', bytes: bytes.length, maxTotalBytes: totalSourceLimit };
        report.sources.push({ sha256: hash, bytes: bytes.length, text: source });
        sourceBytes += bytes.length;
      }
      return { availability: 'available', bytes: bytes.length, chars: source.length, sha256: hash };
    } catch (error) { return { availability: 'unavailable', error: message(error) }; }
  }
  function snapshot(gl, program, id, originalQuery) {
    // The proactive query must not be mislabeled as a later Engine consumption.
    var linkStatus = query(function () { return originalQuery.call(gl, program, gl.LINK_STATUS); });
    var linkInfo = info(function () { return gl.getProgramInfoLog(program); });
    var shaders;
    try {
      var attached = gl.getAttachedShaders(program);
      shaders = attached === null ? null : Array.from(attached).slice(0, 16).map(function (shader) {
        return {
          stage: query(function () { return gl.getShaderParameter(shader, gl.SHADER_TYPE); }),
          compileStatus: query(function () { return gl.getShaderParameter(shader, gl.COMPILE_STATUS); }),
          infoLog: info(function () { return gl.getShaderInfoLog(shader); }),
          source: shaderSource(gl, shader)
        };
      });
    } catch (error) { shaders = { error: message(error) }; }
    var caps = {};
    ['VERSION', 'SHADING_LANGUAGE_VERSION', 'VENDOR', 'RENDERER', 'MAX_VERTEX_ATTRIBS',
      'MAX_VARYING_VECTORS', 'MAX_VERTEX_OUTPUT_COMPONENTS', 'MAX_FRAGMENT_INPUT_COMPONENTS',
      'MAX_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_TEXTURE_IMAGE_UNITS', 'MAX_COMBINED_TEXTURE_IMAGE_UNITS',
      'MAX_TEXTURE_SIZE', 'MAX_UNIFORM_BLOCK_SIZE', 'MAX_UNIFORM_BUFFER_BINDINGS',
      'MAX_VERTEX_UNIFORM_BLOCKS', 'MAX_FRAGMENT_UNIFORM_BLOCKS', 'MAX_COMBINED_UNIFORM_BLOCKS'].forEach(function (name) {
      if (typeof gl[name] === 'number') caps[name] = query(function () { return gl.getParameter(gl[name]); });
    });
    emit({ phase: 'link', context: id, link: ++linkCount,
      linkStatus: linkStatus, infoLog: linkInfo,
      shaders: shaders, caps: caps,
      contextLost: query(function () { return gl.isContextLost(); }) });
    return { link: linkCount, nonTrue: linkStatus.type !== 'boolean' || linkStatus.value !== true };
  }
  function observeContext(gl) {
    if (ended || !gl || contexts.has(gl)) return;
    contexts.add(gl);
    var id = ++contextCount;
    if (id > 4) { finish('context-bound'); return; }
    var originalQuery, programs = new Map();
    releases.push(function () {
      programs.forEach(function (entry) {
        emit({ phase: 'consumer-link-status-unavailable', context: id, link: entry.link,
          reason: 'no-subsequent-query' });
      });
      programs.clear();
    });
    function consumed(program, linkStatus, threw) {
      var entry = programs.get(program);
      if (!entry || ended) return;
      programs.delete(program); // Only the first actual status query per observed link.
      emit({ phase: 'consumer-link-status', context: id, link: entry.link, linkStatus: linkStatus });
      if (threw) finish('consumer-query-threw');
      else if (entry.nonTrue) finish('link-not-true');
      else if (linkStatus.type !== 'boolean' || linkStatus.value !== true) finish('consumer-link-not-true');
    }
    if (!install(gl, 'getProgramParameter', function (original) {
      originalQuery = original;
      return function () {
        var result;
        var observe = this === gl && arguments[1] === gl.LINK_STATUS;
        try { result = original.apply(this, arguments); }
        catch (error) {
          if (observe) {
            try { consumed(arguments[0], { error: message(error) }, true); }
            catch (ignored) { /* Preserve the exact native query exception. */ }
          }
          throw error;
        }
        if (observe) {
          try { consumed(arguments[0], raw(result), false); }
          catch (error) { emit({ phase: 'observation-failed', context: id, error: message(error) }); }
        }
        return result;
      };
    }, 'context-' + id)) { finish('hook-failed'); return; }
    if (!install(gl, 'linkProgram', function (original) {
      return function () {
        var result;
        try { result = original.apply(this, arguments); }
        catch (error) {
          emit({ phase: 'link-threw', context: id, error: message(error) });
          try { snapshot(this, arguments[0], id, originalQuery); }
          catch (ignored) { /* Preserve the native exception even when observation fails. */ }
          finish('link-threw');
          throw error;
        }
        try {
          programs.set(arguments[0], snapshot(this, arguments[0], id, originalQuery));
          if (linkCount >= 32) finish('link-bound');
        }
        catch (error) { emit({ phase: 'observation-failed', context: id, error: message(error) }); }
        return result;
      };
    }, 'context-' + id)) finish('hook-failed');
  }
  function observeCanvas(canvas) {
    if (ended || !canvas || canvases.has(canvas)) return;
    canvases.add(canvas);
    if (!install(canvas, 'getContext', function (original) {
      return function () {
        var result = original.apply(this, arguments);
        if (arguments[0] === 'webgl2') {
          try { observeContext(result); }
          catch (error) { emit({ phase: 'observation-failed', owner: 'canvas', error: message(error) }); }
        }
        return result;
      };
    }, 'canvas')) finish('hook-failed');
  }
  if (install(wx, 'createCanvas', function (original) {
    return function () {
      var result = original.apply(this, arguments);
      try { observeCanvas(result); }
      catch (error) { emit({ phase: 'observation-failed', owner: 'wx', error: message(error) }); }
      return result;
    };
  }, 'wx')) timer = setTimeout(function () { finish('deadline'); }, options.deadlineMs);
  else finish('hook-failed');
})();
