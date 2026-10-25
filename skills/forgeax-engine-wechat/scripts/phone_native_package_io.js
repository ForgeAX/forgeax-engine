/* Diagnostic only: native package boundaries, never file contents or user data. */
export function observeNativePackageIo(wx) {
  var limits = { pending: 128, recent: 32, managers: 8, errorDepth: 3, errorProperties: 32, errorChars: 16384 };
  var report = { limits: limits, hooks: {}, pending: {}, recent: [], started: 0, completed: 0, dropped: 0 };
  var releases = [], managers = new WeakSet(), managerCount = 0, ended = false;
  function method(owner, key, wrap) {
    try {
      var original = Object.getOwnPropertyDescriptor(owner, key), call = owner[key];
      if (typeof call !== 'function' || original && !('value' in original)) {
        report.hooks[key] = 'unavailable'; return;
      }
      var wrapped = wrap(call);
      Object.defineProperty(owner, key, original ? Object.assign({}, original, { value: wrapped })
        : { value: wrapped, configurable: true, writable: true });
      report.hooks[key] = 'installed';
      releases.push(function () {
        if (owner[key] !== wrapped) return;
        if (original) Object.defineProperty(owner, key, original); else delete owner[key];
      });
    } catch (ignored) { report.hooks[key] = 'hook-unavailable'; }
  }
  function field(object, key) {
    var d = object && Object.getOwnPropertyDescriptor(object, key);
    return d && 'value' in d ? d.value : undefined;
  }
  // Only the SDK's native fail callback payload enters this reader. Arbitrary
  // thrown game errors still use the startup collector's inert serializer.
  function nativeFailure(value) {
    var seen = new WeakSet(), chars = 0, truncated = false;
    function read(value, depth) {
      if (typeof value === 'string') {
        var text = value.slice(0, Math.max(0, Math.min(4096, limits.errorChars - chars)));
        if (text.length < value.length) truncated = true;
        chars += text.length; return text;
      }
      if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value !== 'object') return { unavailable: typeof value };
      if (depth >= limits.errorDepth || seen.has(value) || chars >= limits.errorChars) { truncated = true; return { unavailable: 'native-limit' }; }
      seen.add(value);
      var out = Object.create(null), keys;
      try { keys = Object.getOwnPropertyNames(value); }
      catch (ignored) { return { unavailable: 'native-keys' }; }
      if (keys.length > limits.errorProperties) truncated = true;
      keys.slice(0, limits.errorProperties).forEach(function (key) {
        if (key.length > 128 || chars >= limits.errorChars) { truncated = true; return; }
        chars += key.length;
        try { Object.defineProperty(out, key, { value: read(value[key], depth + 1), enumerable: true }); }
        catch (ignored) { Object.defineProperty(out, key, { value: { unavailable: 'native-getter-threw' }, enumerable: true }); }
      });
      return out;
    }
    var captured = read(value, 0);
    return { qualification: 'bounded-native-callback-fields', value: captured, truncated: truncated };
  }
  function request(call, operation, key, accepts) {
    return function (options) {
      if (ended || !options || typeof options !== 'object') return call.apply(this, arguments);
      var name, descriptors, prototype, supported = true;
      try {
        descriptors = Object.getOwnPropertyDescriptors(options);
        name = descriptors[key] && descriptors[key].value;
        if (typeof name !== 'string' || !accepts(name)) supported = false;
        for (var callback of ['success', 'fail']) {
          var callbackDescriptor = descriptors[callback];
          if (callbackDescriptor ? !('value' in callbackDescriptor) : callback in options) {
            report.unsupportedCallbacks = (report.unsupportedCallbacks || 0) + 1;
            supported = false;
          }
        }
        prototype = Object.getPrototypeOf(options);
      } catch (ignored) {
        report.optionInspectionFailed = (report.optionInspectionFailed || 0) + 1;
        supported = false;
      }
      if (!supported) return call.apply(this, arguments);
      if (Object.keys(report.pending).length >= limits.pending) { report.dropped++; return call.apply(this, arguments); }
      var row = { id: ++report.started, operation: operation, target: name.slice(0, 512), startedAt: Date.now() };
      report.pending[row.id] = row;
      function complete(status, value) {
        if (ended || row.status !== undefined) return;
        row.status = status; row.finishedAt = Date.now();
        if (status === 'failed') row.error = nativeFailure(value);
        if (status === 'succeeded') {
          var data = field(value, 'data');
          if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) row.bytes = data.byteLength;
        }
        delete report.pending[row.id]; report.completed++;
        if (report.recent.length >= limits.recent) report.recent.shift();
        report.recent.push(row);
      }
      ['success', 'fail'].forEach(function (key) {
        var original = descriptors[key] && descriptors[key].value;
        descriptors[key] = Object.assign({}, descriptors[key] || { configurable: true, enumerable: true, writable: true }, { value: function (value) {
          try { complete(key === 'success' ? 'succeeded' : 'failed', value); } catch (ignored) { report.inspectionFailed = true; }
          if (typeof original === 'function') {
            try { return original.apply(this, arguments); }
            catch (error) { if (!ended) row.callbackThrew = true; throw error; }
          }
        } });
      });
      var args = Array.prototype.slice.call(arguments);
      args[0] = Object.create(prototype, descriptors);
      try { return call.apply(this, args); }
      catch (error) { try { complete('threw'); } catch (ignored) { report.inspectionFailed = true; } throw error; }
    };
  }
  method(wx, 'loadSubpackage', function (call) {
    return request(call, 'loadSubpackage', 'name', function () { return true; });
  });
  method(wx, 'getFileSystemManager', function (call) {
    return function () {
      var manager = call.apply(this, arguments);
      if (ended || !manager || !['object', 'function'].includes(typeof manager) || managers.has(manager)) return manager;
      if (managerCount >= limits.managers) { report.dropped++; return manager; }
      managers.add(manager); managerCount++;
      ['readFile', 'readCompressedFile'].forEach(function (name) {
        method(manager, name, function (read) {
          return request(read, name, 'filePath', function (path) { return /^payload\//.test(path); });
        });
      });
      return manager;
    };
  });
  return { report: report, release: function () {
    if (ended) return;
    ended = true;
    for (var i = releases.length - 1; i >= 0; i--) {
      try { releases[i](); } catch (ignored) { report.restoreFailed = (report.restoreFailed || 0) + 1; }
    }
  } };
}
