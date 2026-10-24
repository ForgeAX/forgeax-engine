/** Shared author markup and one startup lifecycle, emitted statically for each host. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Whole UI document, before any game program is loaded. */
export function hostStartupDocument(title: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="data:," />
    <title>${escapeHtml(title)}</title>
    <style>
      html, body, #app-shell, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body { background: transparent; }
      #app { display: block; }
      #app-shell { position: relative; isolation: isolate; }
      #game-ui { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
      #forgeax-fps { display: none; position: absolute; top: 12px; left: 50%; margin-left: -46px; width: 92px; box-sizing: border-box; padding: 5px 8px; z-index: 2147483645; border: 1px solid rgb(230 235 245 / 30%); border-radius: 6px; background: rgb(5 12 22 / 88%); color: #ffe17b; font: 600 13px/18px system-ui, sans-serif; text-align: center; pointer-events: none; }
      @media (max-width: 600px) { #forgeax-fps { top: auto; bottom: 12px; } }
      #forgeax-loading { position: absolute; inset: 0; z-index: 2147483646; display: grid; place-items: center; overflow: auto; padding: 24px; box-sizing: border-box; background: #05070b; color: #e6e6e6; font: 15px/1.6 system-ui, sans-serif; text-align: center; opacity: 1; transition: opacity 150ms ease; }
      #forgeax-loading[aria-hidden="true"] { opacity: 0; pointer-events: none; }
      #forgeax-loading-content { display: grid; justify-items: center; gap: 12px; max-width: min(480px, 100%); }
      #forgeax-loading-title { margin: 0; color: #f5f7fa; font-size: clamp(20px, 4vw, 30px); font-weight: 500; letter-spacing: 0.02em; }
      #forgeax-loading-spinner { width: 22px; height: 22px; border: 2px solid rgb(230 235 245 / 20%); border-top-color: rgb(230 235 245 / 78%); border-radius: 50%; animation: forgeax-loading-spin 900ms linear infinite; }
      #forgeax-loading-status { margin: 0; color: rgb(230 235 245 / 72%); }
      #forgeax-loading-slow, #forgeax-loading-reload { display: none; }
      #forgeax-loading-reload, #forgeax-fatal-reload { border: 1px solid rgb(230 235 245 / 35%); border-radius: 5px; padding: 7px 14px; background: transparent; color: inherit; cursor: pointer; font: inherit; }
      #forgeax-fatal { position: absolute; inset: 0; z-index: 2147483647; display: none; place-items: center; overflow: auto; padding: 24px; box-sizing: border-box; background: #0b0d10; color: #e6e6e6; font: 15px/1.6 system-ui, sans-serif; text-align: center; }
      #forgeax-fatal-content { display: grid; gap: 12px; width: min(680px, 100%); text-align: left; }
      #forgeax-fatal-message { margin: 0; font-size: 18px; }
      #forgeax-fatal-details { max-height: 45vh; overflow: auto; white-space: pre-wrap; }
      @keyframes forgeax-loading-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { #forgeax-loading { transition: none; } #forgeax-loading-spinner { animation: none; } }
    </style>
  </head>
  <body>
    <div id="app-shell"><canvas id="app"></canvas><div id="game-ui"></div>
    <div id="forgeax-fps" aria-label="Completed game frames per second">FPS --</div>
    <div id="forgeax-loading" role="status" aria-live="polite" aria-atomic="true">
      <div id="forgeax-loading-content">
        <h1 id="forgeax-loading-title">${escapeHtml(title)}</h1>
        <div id="forgeax-loading-spinner" aria-hidden="true"></div>
        <p id="forgeax-loading-status">Loading…</p>
        <p id="forgeax-loading-slow">Still loading. You can keep waiting or reload.</p>
        <button id="forgeax-loading-reload" type="button">Reload</button>
      </div>
    </div>
    <div id="forgeax-fatal" role="alert">
      <div id="forgeax-fatal-content">
        <p id="forgeax-fatal-message">Unable to start the game.</p>
        <details><summary>Diagnostics</summary><pre id="forgeax-fatal-details"></pre></details>
        <button id="forgeax-fatal-reload" type="button">Reload</button>
      </div>
    </div>
    </div>
    <noscript>JavaScript is required to start this game. Please enable JavaScript and reload.</noscript>
  </body>
</html>
`;
}

/**
 * A JavaScript expression for static bundling, never eval/Function. Native
 * ports: document, events, surface(), now(), visible(), reload(), reducedMotion.
 * Omit the expression for real browser DOM/window. The result exposes the
 * existing prepare/enter/fail/destroy/bindInput/bindSession lifecycle plus
 * submitted(detail) and visibilityChanged() for native App/Platform facts.
 */
export function hostStartupScript(startupScreen = true, hostExpression = 'undefined'): string {
  const startupEnabled = startupScreen ? 'true' : 'false';
  return `
      ((host) => {
        const document = host?.document ?? globalThis.document;
        const window = host?.events ?? globalThis.window;
        const currentCanvas = () => host?.surface?.() ?? document.querySelector('#app');
        const isElement = (node) => host === undefined ? node instanceof HTMLElement : node?.nodeType === 1;
        const isNode = (node) => host === undefined ? node instanceof Node : node !== null && typeof node === 'object';
        const startupEnabled = ${startupEnabled};
        const loading = document.querySelector('#forgeax-loading');
        const loadingStatus = document.querySelector('#forgeax-loading-status');
        const loadingSlow = document.querySelector('#forgeax-loading-slow');
        const loadingReload = document.querySelector('#forgeax-loading-reload');
        const fatal = document.querySelector('#forgeax-fatal');
        const fatalMessage = document.querySelector('#forgeax-fatal-message');
        const fatalDetails = document.querySelector('#forgeax-fatal-details');
        const fatalReload = document.querySelector('#forgeax-fatal-reload');
        const gameUi = document.querySelector('#game-ui');
        const QueryParams = typeof URLSearchParams === 'function'
          ? URLSearchParams
          : class {
              has() {
                return false;
              }
              get() {
                return null;
              }
            };
        const query = typeof location === 'object' && location !== null
          ? new QueryParams(location.search)
          : new QueryParams();
        const gamePage = startupEnabled && (!query.has('forgeaxWorkspace') || query.get('forgeaxWorkspace') === 'game') &&
          !query.has('forgeax-tool-recipe') && !query.has('forgeax-tool-replay');
        // Editor workspace/resource/tool pages omit the game loading overlay.
        // Editor Play uses it and waits for a completed game frame. Every page
        // retains the fatal diagnostic surface and Reload action.
        const fatalEnabled = true;
        let phase = gamePage ? 'loading' : 'disabled';
        let slowTimer;
        let fadeTimer;
        let slowRemainingMs = 15000;
        let slowVisibleSince;
        let latestSubmitted;
        // A completion may legally lag behind a later submission. Keep the
        // submitted frame identities for the active device generation so a
        // successful receipt remains tied to a real frame without requiring
        // the queue to drain to the newest submission.
        let submittedFrames = new Set();
        const submissionKey = (worldIdentity, deviceGeneration, frameId) =>
          JSON.stringify([worldIdentity, deviceGeneration, frameId]);
        let expectedSession;
        let inputBinding;
        let inputEnabled = false;
        let sessionGeneration = 0;
        const reducedMotion =
          host?.reducedMotion ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
        const fadeDurationMs = reducedMotion ? 0 : 150;
        const setStartupTimeout = typeof setTimeout === 'function' ? setTimeout : () => undefined;
        const clearStartupTimeout = (timer) => {
          if (timer !== undefined && typeof clearTimeout === 'function') clearTimeout(timer);
        };
        const reload = () => {
          if (phase === 'destroyed') return;
          destroy();
          if (host !== undefined) host.reload();
          else if (typeof location?.reload === 'function') location.reload();
        };
        const setText = (node, text) => {
          if (node !== null && isElement(node)) node.textContent = text;
        };
        const setDisplay = (node, display) => {
          if (node !== null && isElement(node)) node.style.display = display;
        };
        const setAttribute = (node, name, value) => {
          if (node !== null && isElement(node) && typeof node.setAttribute === 'function') {
            node.setAttribute(name, value);
          }
        };
        const isStartupControlTarget = (target) => {
          if (!(isNode(target))) return false;
          const owns = (node) =>
            node !== null &&
            node !== undefined &&
            (node === target || (typeof node.contains === 'function' && node.contains(target)));
          return owns(loading) || owns(fatal);
        };
        const onStartupInputCapture = (event) => {
          if (inputEnabled || isStartupControlTarget(event?.target)) return;
          // Preserve native Tab navigation into startup controls. The game UI
          // is inert while this owner blocks gameplay, until the first ready frame.
          if (event?.key !== 'Tab') event?.preventDefault?.();
          event?.stopImmediatePropagation?.();
          event?.stopPropagation?.();
        };
        const onStartupControlKey = (event) => {
          // Let the focused Reload button receive its default Enter/Space
          // activation, but stop the key event before it bubbles to the
          // gameplay producer while the startup surface owns the page.
          if (!inputEnabled) event?.stopPropagation?.();
        };
        const startupInputKinds = [
          'keydown',
          'keyup',
          'pointerdown',
          'pointerup',
          'pointermove',
          'pointercancel',
          'mousedown',
          'mouseup',
          'mousemove',
          'wheel',
          'click',
        ];
        const bindStartupInputCapture = () => {
          if (!gamePage || typeof window.addEventListener !== 'function') return;
          for (const kind of startupInputKinds) {
            window.addEventListener(kind, onStartupInputCapture, { capture: true });
          }
        };
        const removeStartupInputCapture = () => {
          if (typeof window.removeEventListener !== 'function') return;
          for (const kind of startupInputKinds) {
            window.removeEventListener(kind, onStartupInputCapture, { capture: true });
          }
        };
        const setInputEnabled = (enabled) => {
          inputEnabled = enabled;
          if (gamePage && isElement(gameUi)) gameUi.inert = !enabled;
          // The one readiness signal for scripted real input: it is open only
          // while this owner admits gameplay input, never on the fatal path.
          const documentRoot = document.documentElement;
          if (gamePage && typeof documentRoot?.setAttribute === 'function') {
            documentRoot.setAttribute('data-forgeax-input', enabled ? 'open' : 'closed');
          }
          try {
            inputBinding?.(enabled);
          } catch {
            // Input is an observational startup bridge; it must not change the
            // fatal error path when an App-owned callback is already disposed.
          }
        };
        const bindInput = (callback) => {
          if (typeof callback !== 'function') return () => {};
          const previous = inputBinding;
          if (previous !== undefined) {
            try {
              previous(false);
            } catch {
              // Continue replacing an already-bound input bridge.
            }
          }
          inputBinding = callback;
          setInputEnabled(false);
          return () => {
            if (inputBinding !== callback) return;
            setInputEnabled(false);
            inputBinding = undefined;
          };
        };
        let fadeCanvasWatch;
        const stopFadeCanvasWatch = () => {
          fadeCanvasWatch?.disconnect();
          fadeCanvasWatch = undefined;
        };
        // While the overlay fades, the presenting canvas already receives
        // input. A Render Worker recovery that replaces it must close input at
        // once, before the replacement can take a click or a pointer lock.
        const watchFadeCanvas = (fadeCanvas) => {
          const parent = fadeCanvas?.parentNode;
          const Observer = document.defaultView?.MutationObserver;
          if (typeof Observer !== 'function' || parent === null || parent === undefined) return;
          fadeCanvasWatch = new Observer(() => {
            if (phase === 'fading' && currentCanvas() !== fadeCanvas) prepare();
          });
          fadeCanvasWatch.observe(parent, { childList: true });
        };
        const clearStartupWork = () => {
          stopFadeCanvasWatch();
          clearStartupTimeout(slowTimer);
          clearStartupTimeout(fadeTimer);
          slowTimer = undefined;
          fadeTimer = undefined;
          slowVisibleSince = undefined;
          submittedFrames = new Set();
        };
        const clockNow = () => {
          if (host !== undefined) return host.now();
          if (typeof performance === 'object' && performance !== null && typeof performance.now === 'function') {
            return performance.now();
          }
          return Date.now();
        };
        const isForeground = () => host?.visible?.() ?? (
          typeof document !== 'object' || document === null || document.visibilityState !== 'hidden');
        // Receipt observation outlives the loading overlay. It does not request
        // render frames or sample rAF; one timer updates text only when changed.
        const frameRate = (() => {
          const node = document.querySelector('#forgeax-fps');
          let closed = !gamePage || node?.id !== 'forgeax-fps';
          let session, surface, deviceGeneration = -1, lastFrame = -1;
          let since, count = 0, timer;
          const text = value => {
            if (node?.textContent !== value) setText(node, value);
          };
          const reset = () => {
            clearStartupTimeout(timer); timer = undefined;
            since = undefined; count = 0;
            text('FPS --'); setDisplay(node, 'none');
          };
          const tick = () => {
            if (closed || !isForeground()) { reset(); return; }
            const now = clockNow();
            const elapsed = now - since;
            if (Number.isFinite(elapsed) && elapsed > 0) {
              text('FPS ' + (count * 1000 / elapsed).toFixed(1));
              count = 0; since = now;
            }
            timer = setStartupTimeout(tick, 1000);
          };
          const completed = detail => {
            const canvas = currentCanvas();
            if (closed || (phase !== 'fading' && phase !== 'entered') || !isForeground() || session === undefined ||
                detail?.worldIdentity !== session || detail.presentation !== 'ready' ||
                !Number.isSafeInteger(detail.frameId) || detail.frameId < 0 ||
                !Number.isSafeInteger(detail.deviceGeneration) || detail.deviceGeneration < 0 ||
                (canvas === surface && detail.deviceGeneration < deviceGeneration)) return;
            if (canvas !== surface || detail.deviceGeneration !== deviceGeneration) {
              reset(); surface = canvas; deviceGeneration = detail.deviceGeneration; lastFrame = -1;
            }
            if (detail.frameId <= lastFrame) return;
            lastFrame = detail.frameId;
            if (since === undefined) {
              since = clockNow();
              setDisplay(node, 'block');
              timer = setStartupTimeout(tick, 1000);
            } else count += 1;
          };
          const onReceipt = event => { if (event.target === currentCanvas()) completed(event.detail); };
          const visibilityChanged = () => reset();
          const pageHidden = event => { if (event.persisted) reset(); else destroy(); };
          const destroy = () => {
            if (closed) return;
            closed = true; reset();
            if (host === undefined) {
              window.removeEventListener('forgeax:frame-completed', onReceipt, { capture: true });
              window.removeEventListener('visibilitychange', visibilityChanged);
              window.removeEventListener('pagehide', pageHidden);
            }
          };
          if (!closed && host === undefined) {
            window.addEventListener('forgeax:frame-completed', onReceipt, { capture: true });
            window.addEventListener('visibilitychange', visibilityChanged);
            window.addEventListener('pagehide', pageHidden);
          }
          return { completed, visibilityChanged, destroy, bindSession(value) {
            if (session === value || closed) return;
            reset(); session = value; surface = undefined; deviceGeneration = -1; lastFrame = -1;
          } };
        })();
        const accountForegroundTime = () => {
          if (slowVisibleSince === undefined) return;
          slowRemainingMs = Math.max(0, slowRemainingMs - Math.max(0, clockNow() - slowVisibleSince));
          slowVisibleSince = undefined;
        };
        const showSlow = () => {
          if (!gamePage || (phase !== 'loading' && phase !== 'preparing') || !isForeground()) return;
          accountForegroundTime();
          if (slowRemainingMs > 0) {
            slowVisibleSince = clockNow();
            slowTimer = setStartupTimeout(showSlow, slowRemainingMs);
            return;
          }
          slowTimer = undefined;
          slowVisibleSince = undefined;
          setDisplay(loadingSlow, 'block');
          setDisplay(loadingReload, 'inline-block');
        };
        const armSlowTimer = () => {
          if (!gamePage || (phase !== 'loading' && phase !== 'preparing') || !isForeground()) return;
          accountForegroundTime();
          clearStartupTimeout(slowTimer);
          if (slowRemainingMs <= 0) {
            showSlow();
            return;
          }
          slowVisibleSince = clockNow();
          slowTimer = setStartupTimeout(showSlow, slowRemainingMs);
        };
        const appendStructuredFailure = (value, prefix, seen, lines) => {
          const formatValue = (candidate) => {
            if (typeof candidate === 'string') return candidate;
            try {
              const encoded = JSON.stringify(candidate);
              if (encoded !== undefined) return encoded;
            } catch {
              // Fall through to String for unserializable diagnostics.
            }
            return String(candidate);
          };
          if (value === null || typeof value !== 'object') {
            if (prefix && value !== undefined) lines.push(prefix + ': ' + formatValue(value));
            return;
          }
          if (seen.size >= 64) {
            lines.push((prefix || 'cause') + ': [diagnostic node limit]');
            return;
          }
          if (seen.has(value)) {
            lines.push((prefix || 'cause') + ': [circular]');
            return;
          }
          seen.add(value);
          if (Array.isArray(value)) {
            value.forEach((nested, index) =>
              appendStructuredFailure(nested, (prefix || 'cause') + '[' + index + ']', seen, lines),
            );
            return;
          }
          const record = value;
          const name = typeof record.name === 'string' && record.name.length > 0
            ? record.name
            : undefined;
          const code = typeof record.code === 'string' && record.code.length > 0
            ? record.code
            : undefined;
          const message = typeof record.message === 'string' && record.message.length > 0
            ? record.message
            : undefined;
          if (name !== undefined || code !== undefined || message !== undefined) {
            const identity = [name || 'Error', code].filter(Boolean).join(' ');
            lines.push((prefix ? prefix + ': ' : '') + identity + (message ? ': ' + message : ''));
          }
          for (const key of ['expected', 'hint', 'reason']) {
            if (record[key] !== undefined && record[key] !== null) {
              lines.push((prefix ? prefix + '.' : '') + key + ': ' + formatValue(record[key]));
            }
          }
          for (const key of ['cause', 'detail', 'failure', 'webgpuError', 'wgpuError', 'error']) {
            const nested = record[key];
            const nestedPrefix = (prefix ? prefix + '.' : '') + key;
            if (nested !== undefined && nested !== null && typeof nested === 'object') {
              appendStructuredFailure(nested, nestedPrefix, seen, lines);
            } else if (nested !== undefined && nested !== null) {
              lines.push(nestedPrefix + ': ' + formatValue(nested));
            }
          }
          const knownKeys = new Set([
            'name',
            'code',
            'message',
            'expected',
            'hint',
            'reason',
            'cause',
            'detail',
            'failure',
            'webgpuError',
            'wgpuError',
            'error',
          ]);
          for (const key of Object.keys(record)) {
            if (knownKeys.has(key)) continue;
            const nested = record[key];
            const nestedPrefix = (prefix ? prefix + '.' : '') + key;
            if (nested !== null && typeof nested === 'object') {
              appendStructuredFailure(nested, nestedPrefix, seen, lines);
            } else if (nested !== undefined) {
              lines.push(nestedPrefix + ': ' + formatValue(nested));
            }
          }
        };
        const formatStartupFailure = (reason) => {
          if (reason !== null && typeof reason === 'object') {
            const lines = [];
            appendStructuredFailure(reason, '', new Set(), lines);
            if (lines.length > 0) return lines.join('\\n');
            try {
              return JSON.stringify(reason) || 'Unknown structured startup failure';
            } catch {
              return 'Unserializable structured startup failure';
            }
          }
          return String(reason ?? 'Unknown startup failure');
        };
        const show = (reason, execution) => {
          const runtimeFailure = execution?.fault !== undefined && execution.fault !== null;
          if (!fatalEnabled || phase === 'failed' || phase === 'destroyed' ||
              (phase === 'entered' && !runtimeFailure)) return;
          phase = 'failed';
          frameRate.destroy();
          setInputEnabled(false);
          clearStartupWork();
          // Retain the first cause through teardown and keep Reload alive.
          cleanupStartupListeners();
          bindStartupInputCapture();
          bindFatalReload();
          let details = formatStartupFailure(reason);
          const notice = fatal;
          if (!(isElement(notice))) return;
          const message = runtimeFailure ? 'The game stopped because execution failed.' : 'Unable to start the game.';
          if (/webgpu|adapter-unavailable|no usable (rendering )?backend/i.test(details)) {
            details += '\\n\\nRenderer diagnosis: ForgeaX supports browser WebGPU and a wgpu/WebGL2 fallback. This failure alone does not prove that WebGPU is unsupported; use the structured code, hint, and nested backend causes above.';
          }
          // Keep the existing plain-text diagnostic fallback for hosts that
          // provide only one synthetic HTMLElement in a test harness.
          if (fatalMessage === notice) {
            notice.textContent = (runtimeFailure ? 'ForgeaX game stopped.\\n' : 'ForgeaX game failed to start.\\n') + message + '\\n' + details;
          } else {
            setText(fatalMessage, message);
            setText(fatalDetails, details);
          }
          setDisplay(loading, 'none');
          setDisplay(notice, 'grid');
          setDisplay(fatalReload, 'inline-block');
          setAttribute(loading, 'aria-hidden', 'true');
          setAttribute(loading, 'data-fading', 'false');
          if (gamePage && fatalReload !== null && isElement(fatalReload)) fatalReload.focus?.();
        };
        const prepare = () => {
          if (!gamePage || (phase !== 'loading' && phase !== 'fading')) return;
          if (phase === 'fading') {
            stopFadeCanvasWatch();
            clearStartupTimeout(fadeTimer);
            fadeTimer = undefined;
            setInputEnabled(false);
            setLoadingControls(true);
            setAttribute(loading, 'aria-hidden', 'false');
            setAttribute(loading, 'data-fading', 'false');
          }
          phase = 'preparing';
          latestSubmitted = undefined;
          submittedFrames = new Set();
          setText(loadingStatus, 'Preparing scene…');
          armSlowTimer();
        };
        const enter = (event) => {
          if (host !== undefined) frameRate.completed(event);
          if (!gamePage || phase !== 'preparing') return;
          if (event === null || typeof event !== 'object') return;
          if (expectedSession === undefined || event.worldIdentity !== expectedSession) return;
          if (
            !Number.isSafeInteger(event.frameId) ||
            event.frameId < 0 ||
            !Number.isSafeInteger(event.deviceGeneration) ||
            event.deviceGeneration < 0
          ) return;
          if (
            latestSubmitted === undefined ||
            latestSubmitted.canvas !== currentCanvas() ||
            event.deviceGeneration !== latestSubmitted.deviceGeneration ||
            (latestSubmitted.worldIdentity !== undefined &&
              event.worldIdentity !== latestSubmitted.worldIdentity) ||
            !submittedFrames.has(
              submissionKey(event.worldIdentity, event.deviceGeneration, event.frameId),
            )
          ) return;
          submittedFrames.delete(
            submissionKey(event.worldIdentity, event.deviceGeneration, event.frameId),
          );
          // A pending completion is still a terminal receipt for this
          // submitted candidate. Retire it before checking presentation so a
          // later forged/replayed ready event cannot reuse the same frame.
          if (event.presentation !== 'ready') return;
          if (phase === 'fading') return;
          phase = 'fading';
          frameRate.completed(event);
          clearStartupWork();
          // The game is presentable now; the fade is cosmetic and must not
          // swallow the first player or scripted input.
          setInputEnabled(true);
          const fadeGeneration = sessionGeneration;
          const fadeCanvas = latestSubmitted.canvas;
          // The hidden overlay keeps neither focus nor its Reload activation:
          // Enter/Space during the fade belong to the game alone.
          setLoadingControls(false);
          setAttribute(loading, 'data-fading', 'true');
          setAttribute(loading, 'aria-hidden', 'true');
          watchFadeCanvas(fadeCanvas);
          fadeTimer = setStartupTimeout(() => {
            if (phase !== 'fading' || fadeGeneration !== sessionGeneration) return;
            if (fadeCanvas !== currentCanvas()) {
              prepare();
              return;
            }
            stopFadeCanvasWatch();
            phase = 'entered';
            setDisplay(loading, 'none');
            setAttribute(loading, 'data-fading', 'false');
            cleanupStartupListeners();
          }, fadeDurationMs);
        };
        const destroy = () => {
          if (phase === 'destroyed') return;
          sessionGeneration += 1;
          phase = 'destroyed';
          frameRate.destroy();
          setInputEnabled(false);
          clearStartupWork();
          cleanupStartupListeners();
        };
        const onSubmitted = (event) => {
          if (phase === 'entered' || phase === 'failed' || phase === 'destroyed') return;
          if (event?.target !== currentCanvas()) return;
          const detail = event?.detail;
          if (
            detail !== null &&
            typeof detail === 'object' &&
            Number.isSafeInteger(detail.frameId) &&
            detail.frameId >= 0 &&
            Number.isSafeInteger(detail.deviceGeneration) &&
            detail.deviceGeneration >= 0 &&
            expectedSession !== undefined &&
            detail.worldIdentity === expectedSession
          ) {
            if (
              latestSubmitted !== undefined &&
              (detail.deviceGeneration !== latestSubmitted.deviceGeneration ||
                event.target !== latestSubmitted.canvas)
            ) {
              if (phase === 'fading') prepare();
              else submittedFrames = new Set();
            }
            latestSubmitted = {
              canvas: event.target,
              frameId: detail.frameId,
              deviceGeneration: detail.deviceGeneration,
              worldIdentity: detail.worldIdentity,
            };
            submittedFrames.add(
              submissionKey(detail.worldIdentity, detail.deviceGeneration, detail.frameId),
            );
          }
        };
        const onCompleted = (event) => {
          if (event?.target === currentCanvas()) enter(event?.detail);
        };
        const onVisibilityChange = () => {
          frameRate.visibilityChanged();
          if (isForeground()) {
            armSlowTimer();
          } else {
            accountForegroundTime();
            clearStartupTimeout(slowTimer);
            slowTimer = undefined;
          }
        };
        const onPageHide = () => destroy();
        const onError = (event) => {
          if (event?.error !== undefined) {
            show(event.error);
            return;
          }
          const target = event?.target;
          const source =
            target !== null &&
            target !== undefined &&
            (typeof target.src === 'string' || typeof target.href === 'string')
              ? target.src ?? target.href
              : undefined;
          if (source !== undefined || event?.message !== undefined) {
            show({
              name: 'ScriptResourceError',
              message: event?.message ?? 'startup resource failed to load',
              ...(source === undefined ? {} : { detail: { source } }),
            });
            return;
          }
          show(event);
        };
        const onUnhandledRejection = (event) => show(event?.reason ?? event);
        const setLoadingControls = (active) => {
          if (loading !== null && isElement(loading)) {
            loading.inert = !active;
            const focused = document.activeElement;
            if (!active && focused !== null && focused !== undefined && typeof loading.contains === 'function' && loading.contains(focused)) {
              focused.blur?.();
            }
          }
          if (
            loadingReload === null ||
            !isElement(loadingReload) ||
            typeof loadingReload.addEventListener !== 'function'
          ) return;
          const listen = active ? 'addEventListener' : 'removeEventListener';
          loadingReload[listen]('click', reload);
          loadingReload[listen]('keydown', onStartupControlKey);
          loadingReload[listen]('keyup', onStartupControlKey);
        };
        const cleanupStartupListeners = () => {
          if (typeof window.removeEventListener === 'function') {
            window.removeEventListener('forgeax:frame-submitted', onSubmitted, { capture: true });
            window.removeEventListener('forgeax:frame-completed', onCompleted, { capture: true });
            window.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('pagehide', onPageHide);
            window.removeEventListener('error', onError, { capture: true });
            window.removeEventListener('unhandledrejection', onUnhandledRejection);
          }
          removeStartupInputCapture();
          if (loadingReload !== null && typeof loadingReload.removeEventListener === 'function') {
            loadingReload.removeEventListener('click', reload);
            loadingReload.removeEventListener('keydown', onStartupControlKey);
            loadingReload.removeEventListener('keyup', onStartupControlKey);
          }
          if (
            fatalReload !== null &&
            typeof fatalReload.removeEventListener === 'function'
          ) {
            fatalReload.removeEventListener('click', reload);
            fatalReload.removeEventListener('keydown', onStartupControlKey);
            fatalReload.removeEventListener('keyup', onStartupControlKey);
          }
        };
        setLoadingControls(true);
        const bindFatalReload = () => {
          if (
            fatalReload === null ||
            !isElement(fatalReload) ||
            typeof fatalReload.addEventListener !== 'function'
          ) return;
          fatalReload.addEventListener('click', reload);
          fatalReload.addEventListener('keydown', onStartupControlKey);
          fatalReload.addEventListener('keyup', onStartupControlKey);
        };
        if (gamePage) {
          // Render Worker recovery replaces its transferred canvas. Capture
          // nonbubbling receipts on the stable page and admit only its current
          // canvas; retired or unrelated surfaces cannot enter this game.
          window.addEventListener('forgeax:frame-submitted', onSubmitted, { capture: true });
          window.addEventListener('forgeax:frame-completed', onCompleted, { capture: true });
          window.addEventListener('visibilitychange', onVisibilityChange);
          window.addEventListener('pagehide', onPageHide);
          bindStartupInputCapture();
        }
        if (fatalEnabled) {
          // Keep module/resource errors observable even when a workspace or
          // preview page intentionally starts with no loading overlay.
          window.addEventListener('error', onError, { capture: true });
          window.addEventListener('unhandledrejection', onUnhandledRejection);
        }
        if (gamePage) {
          setInputEnabled(false);
          armSlowTimer();
        } else {
          setDisplay(loading, 'none');
        }
        const bindSession = (session) => {
          if (typeof session !== 'string' || session.length === 0) return;
          frameRate.bindSession(session);
          if (phase === 'entered' || phase === 'failed' || phase === 'destroyed') return;
          if (expectedSession === session) return;
          expectedSession = session;
          sessionGeneration += 1;
          latestSubmitted = undefined;
          submittedFrames = new Set();
          if (phase === 'loading' || phase === 'preparing' || phase === 'fading') {
            accountForegroundTime();
            clearStartupWork();
            if (phase === 'fading') setLoadingControls(true);
            phase = 'loading';
            setInputEnabled(false);
            setDisplay(loading, 'grid');
            setDisplay(fatal, 'none');
            setAttribute(loading, 'aria-hidden', 'false');
            setAttribute(loading, 'data-fading', 'false');
            setText(loadingStatus, 'Loading…');
            armSlowTimer();
          }
        };
        const startup = Object.freeze({
          prepare,
          enter,
          fail: show,
          destroy,
          bindInput,
          bindSession,
          submitted: (detail) => onSubmitted({ target: currentCanvas(), detail }),
          visibilityChanged: onVisibilityChange,
        });
        if (host === undefined) globalThis.__forgeaxStartup = startup;
        return startup;
      })(${hostExpression});
`;
}
