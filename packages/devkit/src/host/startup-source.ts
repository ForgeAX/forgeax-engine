/** Shared author markup and one startup lifecycle, emitted statically for each host. */
import { DEFAULT_LOAD_PROGRESS_LABELS, type LoadProgressLabels } from '@forgeax/engine-types';
import type { HostVersions } from './versions.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Script-safe JSON literal for an inline classic script. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

/**
 * Whole UI document, before any game program is loaded. The cover first shows
 * the engine-code phase, which is the work in progress at first paint.
 */
export function hostStartupDocument(
  title: string,
  labels: LoadProgressLabels = DEFAULT_LOAD_PROGRESS_LABELS,
  versions?: HostVersions,
): string {
  const status = labels.phases['engine-code'] ?? labels.loading;
  return `<!doctype html>
<html lang="${escapeHtml(labels.lang)}">
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
      #forgeax-status { display: none; position: absolute; left: 10px; bottom: 8px; max-width: calc(100% - 20px); z-index: 2147483645; color: #fff; opacity: 0.5; font: 400 10px/14px system-ui, sans-serif; pointer-events: none; user-select: none; }
      #forgeax-loading { position: absolute; inset: 0; z-index: 2147483646; display: grid; place-items: center; overflow: auto; padding: 24px; box-sizing: border-box; background: #05070b; color: #e6e6e6; font: 15px/1.6 system-ui, sans-serif; text-align: center; opacity: 1; transition: opacity 150ms ease; }
      #forgeax-loading[aria-hidden="true"] { opacity: 0; pointer-events: none; }
      #forgeax-loading-content { display: grid; justify-items: center; gap: 12px; max-width: min(480px, 100%); }
      #forgeax-loading-title { margin: 0; color: #f5f7fa; font-size: clamp(20px, 4vw, 30px); font-weight: 500; letter-spacing: 0.02em; }
      #forgeax-loading-spinner { width: 22px; height: 22px; border: 2px solid rgb(230 235 245 / 20%); border-top-color: rgb(230 235 245 / 78%); border-radius: 50%; animation: forgeax-loading-spin 900ms linear infinite; }
      #forgeax-loading-status { margin: 0; color: rgb(230 235 245 / 72%); }
      #forgeax-loading-progress { width: min(360px, 80vw); height: 4px; border-radius: 2px; overflow: hidden; background: rgb(230 235 245 / 14%); }
      #forgeax-loading-fill { width: 0; height: 100%; background: rgb(230 235 245 / 78%); transition: width 200ms linear; }
      #forgeax-loading-detail, #forgeax-loading-meta { margin: 0; min-height: 1.5em; max-width: 100%; overflow: hidden; color: rgb(230 235 245 / 52%); font-size: 13px; }
      #forgeax-loading-slow, #forgeax-loading-reload { display: none; }
      #forgeax-loading-reload, #forgeax-fatal-reload { border: 1px solid rgb(230 235 245 / 35%); border-radius: 5px; padding: 7px 14px; background: transparent; color: inherit; cursor: pointer; font: inherit; }
      #forgeax-fatal { position: absolute; inset: 0; z-index: 2147483647; display: none; place-items: center; overflow: auto; padding: 24px; box-sizing: border-box; background: #0b0d10; color: #e6e6e6; font: 15px/1.6 system-ui, sans-serif; text-align: center; }
      #forgeax-fatal-content { display: grid; gap: 12px; width: min(680px, 100%); text-align: left; }
      #forgeax-fatal-message { margin: 0; font-size: 18px; }
      #forgeax-fatal-details { max-height: 45vh; overflow: auto; white-space: pre-wrap; }
      @keyframes forgeax-loading-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { #forgeax-loading, #forgeax-loading-fill { transition: none; } #forgeax-loading-spinner { animation: none; } }
    </style>
  </head>
  <body>
    <div id="app-shell"><canvas id="app"></canvas><div id="game-ui"></div>
    <div id="forgeax-status">${versions === undefined ? '' : `Game ${escapeHtml(versions.game)} | Engine ${escapeHtml(versions.engine)} | `}<span id="forgeax-fps" aria-label="Completed game frames per second">FPS --</span></div>
    <div id="forgeax-loading" role="status" aria-live="polite" aria-atomic="true">
      <div id="forgeax-loading-content">
        <h1 id="forgeax-loading-title">${escapeHtml(title)}</h1>
        <div id="forgeax-loading-spinner" aria-hidden="true"></div>
        <p id="forgeax-loading-status">${escapeHtml(status)}</p>
        <div id="forgeax-loading-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-labelledby="forgeax-loading-status"><div id="forgeax-loading-fill"></div></div>
        <p id="forgeax-loading-detail"></p>
        <p id="forgeax-loading-meta">0%</p>
        <p id="forgeax-loading-slow">${escapeHtml(labels.slow)}</p>
        <button id="forgeax-loading-reload" type="button">${escapeHtml(labels.reload)}</button>
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
 * submitted(detail) and visibilityChanged() for native App/Platform facts,
 * progress(view) for the Engine load progress model and onEntered(callback).
 */
export function hostStartupScript(
  startupScreen = true,
  hostExpression = 'undefined',
  labels: LoadProgressLabels = DEFAULT_LOAD_PROGRESS_LABELS,
): string {
  const startupEnabled = startupScreen ? 'true' : 'false';
  return `
      ((host) => {
        const document = host?.document ?? globalThis.document;
        const window = host?.events ?? globalThis.window;
        const findCanvas = (root) => {
          const preferred = root?.querySelector?.('canvas#app') ?? root?.querySelector?.('#app');
          if (preferred !== null && preferred !== undefined) return preferred;
          let fallback = root?.querySelector?.('canvas');
          const descendants = root?.querySelectorAll?.('*');
          if (descendants === null || descendants === undefined) return fallback;
          for (const element of descendants) {
            const nested = findCanvas(element.shadowRoot);
            if (nested?.id === 'app') return nested;
            fallback ??= nested;
          }
          return fallback;
        };
        let cachedCanvas;
        const currentCanvas = () => {
          const surface = host?.surface?.();
          if (surface !== null && surface !== undefined) return surface;
          if (cachedCanvas !== null && cachedCanvas !== undefined && cachedCanvas.isConnected !== false)
            return cachedCanvas;
          cachedCanvas = findCanvas(document);
          return cachedCanvas;
        };
        const eventCanvas = (event) => {
          if (typeof event?.composedPath === 'function') {
            for (const node of event.composedPath()) {
              if (node?.nodeType === 1 && node.tagName === 'CANVAS') return node;
            }
          }
          return event?.target;
        };
        const isElement = (node) => host === undefined ? node instanceof HTMLElement : node?.nodeType === 1;
        const isNode = (node) => host === undefined ? node instanceof Node : node !== null && typeof node === 'object';
        const startupEnabled = ${startupEnabled};
        const loading = document.querySelector('#forgeax-loading');
        const loadingStatus = document.querySelector('#forgeax-loading-status');
        const loadingSlow = document.querySelector('#forgeax-loading-slow');
        const loadingReload = document.querySelector('#forgeax-loading-reload');
        const loadingDetail = document.querySelector('#forgeax-loading-detail');
        const loadingProgress = document.querySelector('#forgeax-loading-progress');
        const loadingFill = document.querySelector('#forgeax-loading-fill');
        const loadingMeta = document.querySelector('#forgeax-loading-meta');
        const labels = ${scriptJson(labels)};
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
        // Progress view: the Engine model drives it once the game module runs;
        // before that, the cover counts the page's downloaded script bytes.
        let elapsedTimer;
        let progressBound = false;
        let shownPercent = 0;
        let shownElapsed = '';
        let lastView;
        let enteredCallbacks = [];
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
          clearStartupTimeout(elapsedTimer);
          slowTimer = undefined;
          fadeTimer = undefined;
          elapsedTimer = undefined;
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
        const startedAt = host === undefined ? 0 : clockNow();
        const showText = (node, text) => {
          if (node !== null && isElement(node) && node.textContent !== text) node.textContent = text;
        };
        const megabytes = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';
        const scriptBytes = () => {
          if (typeof performance !== 'object' || performance === null || typeof performance.getEntriesByType !== 'function') return 0;
          let bytes = 0;
          for (const entry of performance.getEntriesByType('resource')) {
            if (entry.initiatorType === 'script' || /\\.m?js(\\?|$)/.test(entry.name)) bytes += entry.transferSize || entry.encodedBodySize || 0;
          }
          return bytes;
        };
        const showMeta = () => showText(loadingMeta, shownPercent + '%' + (shownElapsed === '' ? '' : ' · ' + shownElapsed));
        const showPercent = (percent) => {
          shownPercent = Math.max(shownPercent, percent);
          showMeta();
          if (loadingFill !== null && isElement(loadingFill)) loadingFill.style.width = shownPercent + '%';
          setAttribute(loadingProgress, 'aria-valuenow', String(shownPercent));
        };
        const tickElapsed = () => {
          elapsedTimer = undefined;
          if (!gamePage || (phase !== 'loading' && phase !== 'preparing')) return;
          const seconds = Math.max(0, Math.floor((clockNow() - startedAt) / 1000));
          shownElapsed = String(labels.elapsed).replace('{seconds}', String(seconds));
          showMeta();
          if (!progressBound) {
            const bytes = scriptBytes();
            if (bytes > 0) showText(loadingDetail, megabytes(bytes));
          }
          elapsedTimer = setStartupTimeout(tickElapsed, 500);
        };
        const progress = (view) => {
          if (!gamePage || (phase !== 'loading' && phase !== 'preparing')) return;
          if (view === null || typeof view !== 'object') return;
          progressBound = true;
          lastView = view;
          showText(loadingStatus, typeof view.activity === 'string' ? view.activity : labels.loading);
          showText(loadingDetail, typeof view.detail === 'string' ? view.detail : '');
          if (Number.isFinite(view.percent)) showPercent(Math.max(0, Math.min(100, Math.floor(view.percent))));
        };
        const onEntered = (callback) => {
          if (typeof callback === 'function') enteredCallbacks.push(callback);
        };
        const runEntered = () => {
          const callbacks = enteredCallbacks;
          enteredCallbacks = [];
          for (const callback of callbacks) {
            try {
              callback();
            } catch {
              // An App progress owner must not block entering the game.
            }
          }
        };
        // Receipt observation outlives the loading overlay. It does not request
        // render frames or sample rAF; one timer updates text only when changed.
        const frameRate = (() => {
          const node = document.querySelector('#forgeax-fps');
          const status = document.querySelector('#forgeax-status');
          let closed = !gamePage || node?.id !== 'forgeax-fps';
          let session, surface, deviceGeneration = -1, lastFrame = -1;
          let since, count = 0, timer;
          const text = value => {
            if (node?.textContent !== value) setText(node, value);
          };
          const reset = () => {
            clearStartupTimeout(timer); timer = undefined;
            since = undefined; count = 0;
            text('FPS --'); setDisplay(status, 'none');
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
              setDisplay(status, 'block');
              timer = setStartupTimeout(tick, 1000);
            } else count += 1;
          };
          const onReceipt = event => { if (eventCanvas(event) === currentCanvas()) completed(event.detail); };
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
          if (gamePage && elapsedTimer === undefined) tickElapsed();
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
          setText(loadingStatus, labels.phases['first-frame'] ?? labels.loading);
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
          runEntered();
          const fadeGeneration = sessionGeneration;
          const fadeCanvas = latestSubmitted.canvas;
          // The hidden overlay keeps neither focus nor its Reload activation:
          // Enter/Space during the fade belong to the game alone.
          setLoadingControls(false);
          showPercent(100);
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
          const canvas = eventCanvas(event);
          if (canvas !== currentCanvas()) return;
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
                canvas !== latestSubmitted.canvas)
            ) {
              if (phase === 'fading') prepare();
              else submittedFrames = new Set();
            }
            latestSubmitted = {
              canvas,
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
          if (eventCanvas(event) === currentCanvas()) enter(event?.detail);
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
            // A rebound session keeps showing the latest measured work.
            if (lastView === undefined) setText(loadingStatus, labels.loading);
            else progress(lastView);
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
          progress,
          onEntered,
        });
        if (host === undefined) globalThis.__forgeaxStartup = startup;
        return startup;
      })(${hostExpression});
`;
}
