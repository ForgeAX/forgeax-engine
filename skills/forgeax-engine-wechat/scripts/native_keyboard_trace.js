/* Diagnostic only. Never retain entered text or change keyboard/focus policy. */
export function observeNativeKeyboard(wx, readFocus, schedule = setTimeout, unschedule = clearTimeout) {
  const report = { kind: 'forgeax-native-keyboard-trace', limit: 64, events: [], dropped: 0, hooks: {}, ended: false };
  const releases = [];
  function record(operation, event) {
    if (report.ended) return;
    if (report.events.length >= report.limit) { report.dropped++; return; }
    try {
    const row = { operation, at: Date.now() };
    if (event && typeof event.value === 'string') row.valueLength = event.value.length;
    if (event && Number.isFinite(event.height)) row.keyboardHeight = event.height;
    if (event && event.size) row.window = { width: event.size.windowWidth, height: event.size.windowHeight };
    try { row.focused = readFocus(); } catch { row.focusUnavailable = true; }
    if (operation === 'hideKeyboard') row.stack = String(new Error().stack || '').slice(0, 2048);
    report.events.push(row);
    } catch { report.collectionFailed = (report.collectionFailed || 0) + 1; }
  }
  for (const name of ['showKeyboard', 'hideKeyboard']) {
    try {
      const original = Object.getOwnPropertyDescriptor(wx, name), call = wx[name];
      if (typeof call !== 'function' || original && !original.configurable && !original.writable) {
        report.hooks[name] = 'unavailable'; continue;
      }
      const wrapped = function () { record(name); return call.apply(this, arguments); };
      Object.defineProperty(wx, name, { value: wrapped, configurable: original ? original.configurable : true,
        enumerable: original ? original.enumerable : true, writable: true });
      report.hooks[name] = 'installed';
      releases.push(() => {
        if (wx[name] !== wrapped) return;
        if (original) Object.defineProperty(wx, name, original); else delete wx[name];
      });
    } catch { report.hooks[name] = 'unavailable'; }
  }
  for (const name of ['KeyboardInput', 'KeyboardConfirm', 'KeyboardComplete', 'KeyboardHeightChange', 'WindowResize', 'Show', 'Hide', 'TouchCancel']) {
    const on = wx['on' + name], off = wx['off' + name];
    if (typeof on !== 'function' || typeof off !== 'function') { report.hooks[name] = 'unavailable'; continue; }
    const listener = event => record(name, event);
    try {
      on.call(wx, listener);
      releases.push(() => off.call(wx, listener));
      report.hooks[name] = 'installed';
    } catch { report.hooks[name] = 'unavailable'; }
  }
  let timer;
  function release() {
    if (report.ended) return;
    report.ended = true;
    unschedule(timer);
    for (const close of releases.reverse()) {
      try { close(); } catch { report.cleanupFailed = (report.cleanupFailed || 0) + 1; }
    }
  }
  timer = schedule(release, 120000);
  return { report, release };
}
