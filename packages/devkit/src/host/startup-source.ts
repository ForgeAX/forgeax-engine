/** Shared author markup and one startup lifecycle, emitted statically for each host. */
import {
  DEFAULT_LOAD_PROGRESS_LABELS,
  encodeBase64,
  type LoadProgressLabels,
} from '@forgeax/engine-types';
import forgeaxLogo from './forgeax-logo.svg?raw';
import { type StartupCacheIdentity, startupCacheSource } from './startup-cache-source.js';
import type { StartupUiOptions, StartupUiTemplate } from './startup-ui.js';
import type { HostVersions } from './versions.js';

const FORGEAX_LOGO_DATA_URI = `data:image/svg+xml;base64,${encodeBase64(new TextEncoder().encode(forgeaxLogo))}`;

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

function startupMarkup(
  id: string,
  role: string,
  template: StartupUiOptions['loading'],
  fallback: string,
): string {
  if (template === 'none') return '';
  if (template === undefined || template === 'default') return fallback;
  return `<div id="${id}" class="forgeax-startup-custom" role="${role}"${role === 'alert' ? ' style="display:none"' : ''}>${template.html}</div>`;
}

/**
 * Whole UI document, before any game program is loaded. The cover first shows
 * the engine-code phase, which is the work in progress at first paint.
 */
export function hostStartupDocument(
  title: string,
  labels: LoadProgressLabels = DEFAULT_LOAD_PROGRESS_LABELS,
  versions?: HostVersions,
  ui: StartupUiOptions = {},
): string {
  const status = labels.phases['engine-code'] ?? labels.loading;
  const html = `<!doctype html>
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
      #forgeax-loading { position: absolute; inset: 0; z-index: 2147483646; display: grid; place-items: center; overflow: auto; padding: 24px; box-sizing: border-box; background: #07090d; color: #e6e6e6; font: 15px/1.6 system-ui, sans-serif; text-align: center; opacity: 1; transition: opacity 150ms ease; }
      #forgeax-loading[aria-hidden="true"] { opacity: 0; pointer-events: none; }
      #forgeax-loading-content { position: absolute; inset: 0; }
      #forgeax-loading-brand { display: flex; align-items: center; gap: 9px; min-width: 0; white-space: nowrap; }
      #forgeax-loading-logo { display: block; flex: 0 0 auto; width: 28px; height: auto; }
      #forgeax-loading-brand-name { color: rgb(245 247 250 / 82%); font-size: 16px; font-weight: 600; letter-spacing: 0.02em; line-height: 1; }
      #forgeax-loading-title { position: absolute; top: 50%; right: 24px; left: 24px; margin: 0; color: #f5f7fa; font-size: clamp(26px, 4vw, 38px); font-weight: 600; letter-spacing: 0.01em; line-height: 1.2; overflow-wrap: anywhere; transform: translateY(-50%); }
      #forgeax-loading-progress-content { position: absolute; right: clamp(16px, 4vw, 64px); bottom: clamp(22px, 6vh, 52px); left: clamp(16px, 4vw, 64px); display: grid; gap: 12px; text-align: left; }
      #forgeax-loading-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 3fr); align-items: center; column-gap: 16px; }
      #forgeax-loading-summary { display: flex; align-items: baseline; justify-content: flex-end; gap: 10px; min-width: 0; white-space: nowrap; font-size: 13px; line-height: 1.6; }
      #forgeax-loading-status { flex: 0 0 auto; margin: 0; color: rgb(230 235 245 / 62%); }
      #forgeax-loading-detail { flex: 0 1 auto; min-width: 1em; margin: 0; overflow: hidden; color: rgb(230 235 245 / 42%); }
      #forgeax-loading-detail:empty { display: none; }
      #forgeax-loading-meta { flex: 0 0 auto; margin: 0; color: rgb(230 235 245 / 62%); font-variant-numeric: tabular-nums; }
      #forgeax-loading-progress { width: 100%; height: 3px; border-radius: 2px; overflow: hidden; background: rgb(230 235 245 / 11%); }
      #forgeax-loading-fill { width: 0; height: 100%; background: #c6764f; transition: width 200ms linear; }
      #forgeax-loading-slow, #forgeax-loading-reload { margin: 0; justify-self: end; }
      #forgeax-loading-slow, #forgeax-loading-reload { display: none; }
      #forgeax-loading-reload, #forgeax-fatal-copy, #forgeax-fatal-reload { border: 1px solid rgb(230 235 245 / 35%); border-radius: 5px; padding: 7px 14px; background: transparent; color: inherit; cursor: pointer; font: inherit; }
      #forgeax-fatal { position: absolute; inset: 0; z-index: 2147483647; display: none; place-items: center; overflow: auto; padding: 24px; box-sizing: border-box; background: #0b0d10; color: #e6e6e6; font: 15px/1.6 system-ui, sans-serif; text-align: center; }
      #forgeax-fatal-content { display: grid; gap: 12px; width: min(680px, 100%); text-align: left; }
      #forgeax-fatal-message { margin: 0; font-size: 18px; }
      #forgeax-fatal-diagnostics-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
      #forgeax-fatal-diagnostics-title { margin: 0; font-size: 15px; font-weight: 600; }
      #forgeax-fatal-copy-status { min-height: 1.5em; margin: 0; color: rgb(230 235 245 / 68%); font-size: 12px; }
      #forgeax-fatal-details { min-width: 0; max-height: 45vh; margin: 0; padding: 12px; border: 1px solid rgb(230 235 245 / 16%); border-radius: 5px; background: rgb(0 0 0 / 24%); overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; }
      @media (max-width: 600px) {
        #forgeax-loading-row { column-gap: 10px; }
        #forgeax-loading-brand { gap: 5px; }
        #forgeax-loading-logo { width: 18px; }
        #forgeax-loading-brand-name { font-size: 12px; }
        #forgeax-loading-summary { gap: 3px; font-size: clamp(8px, 2.6vw, 13px); }
      }
      @media (max-width: 360px) {
        #forgeax-loading-brand { gap: 4px; }
        #forgeax-loading-logo { width: 16px; }
        #forgeax-loading-brand-name { font-size: 10px; }
      }
      @media (prefers-reduced-motion: reduce) { #forgeax-loading, #forgeax-loading-fill { transition: none; } }
    </style>
  </head>
  <body>
    <div id="app-shell"><canvas id="app"></canvas><div id="game-ui"></div>
    <div id="forgeax-status">${versions === undefined ? '' : `Game ${escapeHtml(versions.game)} | Engine ${escapeHtml(versions.engine)} | `}<span id="forgeax-fps" aria-label="Completed game frames per second">FPS --</span></div>
${startupMarkup(
  'forgeax-loading',
  'status',
  ui.loading,
  `    <div id="forgeax-loading" role="status" aria-live="polite" aria-atomic="true">
      <div id="forgeax-loading-content">
        <h1 id="forgeax-loading-title">${escapeHtml(title)}</h1>
        <div id="forgeax-loading-progress-content">
          <div id="forgeax-loading-row">
            <div id="forgeax-loading-brand">
              <img id="forgeax-loading-logo" src="${FORGEAX_LOGO_DATA_URI}" alt="" aria-hidden="true" />
              <span id="forgeax-loading-brand-name">ForgeAX</span>
            </div>
            <div id="forgeax-loading-summary">
              <p id="forgeax-loading-status">${escapeHtml(status)}</p>
              <p id="forgeax-loading-detail"></p>
              <p id="forgeax-loading-meta">0% · ${escapeHtml(labels.elapsed.replace('{seconds}', '0'))}</p>
            </div>
          </div>
          <div id="forgeax-loading-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-labelledby="forgeax-loading-status"><div id="forgeax-loading-fill"></div></div>
          <p id="forgeax-loading-slow">${escapeHtml(labels.slow)}</p>
          <button id="forgeax-loading-reload" type="button">${escapeHtml(labels.reload)}</button>
        </div>
      </div>
    </div>
`,
)}
${startupMarkup(
  'forgeax-fatal',
  'alert',
  ui.failure,
  `    <div id="forgeax-fatal" role="alert">
      <div id="forgeax-fatal-content">
        <p id="forgeax-fatal-message">Unable to start the game.</p>
        <section id="forgeax-fatal-diagnostics" aria-labelledby="forgeax-fatal-diagnostics-title">
          <div id="forgeax-fatal-diagnostics-header">
            <h2 id="forgeax-fatal-diagnostics-title">Diagnostics</h2>
            <button id="forgeax-fatal-copy" type="button">Copy diagnostics</button>
          </div>
          <p id="forgeax-fatal-copy-status" aria-live="polite"></p>
          <pre id="forgeax-fatal-details" tabindex="0"></pre>
        </section>
        <button id="forgeax-fatal-reload" type="button">Reload</button>
      </div>
    </div>
`,
)}
    </div>
    <noscript>JavaScript is required to start this game. Please enable JavaScript and reload.</noscript>
  </body>
</html>
`;
  const styles = [ui.loading, ui.failure]
    .filter((template): template is StartupUiTemplate => typeof template === 'object')
    .map((template) => template.css ?? '')
    .join('\n');
  const customRoots = [
    typeof ui.loading === 'object' ? '#forgeax-loading' : '',
    typeof ui.failure === 'object' ? '#forgeax-fatal' : '',
  ]
    .filter(Boolean)
    .join(', ');
  return html.replace(
    '  </head>',
    `<style>
${ui.loading === 'none' ? '#app-shell { background: #000; }' : ''}
${customRoots === '' ? '' : `${customRoots} { display: grid; padding: 0; background: #000; color: #e6e6e6; font: 15px/1.6 system-ui, sans-serif; text-align: initial; }`}
${styles.replaceAll('<', '\\3c ')}
</style>\n  </head>`,
  );
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
  cacheIdentity?: StartupCacheIdentity,
  ui: StartupUiOptions = {},
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
        const fatalCopy = document.querySelector('#forgeax-fatal-copy');
        const fatalCopyStatus = document.querySelector('#forgeax-fatal-copy-status');
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
        // retains fatal diagnostics independently of the chosen presentation.
        const fatalEnabled = true;
        const startupCache = ${startupCacheSource(cacheIdentity)};
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
        let shownActivity = labels.phases['engine-code'] ?? labels.loading;
        let shownDetail = '';
        let lastView;
        let uiMessage = '', uiDiagnostics = '', uiRecovery = 'idle', uiCopyStatus = 'idle';
        const uiListeners = new Set();
        const uiDisposers = new Map();
        const snapshotUi = () => Object.freeze({ phase,
            progress: Object.freeze({ percent: shownPercent,
              activity: shownActivity, detail: shownDetail, elapsed: shownElapsed }),
            slow: slowRemainingMs <= 0, message: uiMessage, diagnostics: uiDiagnostics,
            recovery: uiRecovery, copyStatus: uiCopyStatus });
        const notifyUi = () => {
          const state = snapshotUi();
          for (const listener of uiListeners) {
            try { listener(state); } catch (error) { console.error('[ForgeAX startup UI]', error); }
          }
        };
        const disposeUi = (kind) => {
          const dispose = uiDisposers.get(kind);
          uiDisposers.delete(kind);
          try { dispose?.(); } catch (error) { console.error('[ForgeAX startup UI cleanup]', error); }
        };
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
          // The page is going away: keep the game UI inert under the cover.
          destroy(false);
          if (host !== undefined) host.reload();
          else if (typeof location?.reload === 'function') location.reload();
        };
        const setText = (node, text) => {
          if (node !== null && isElement(node)) node.textContent = text;
        };
        const setDisplay = (node, display) => {
          if (node !== null && isElement(node)) {
            const custom = (node === loading && ${typeof ui.loading === 'object'}) || (node === fatal && ${typeof ui.failure === 'object'});
            node.style.display = display === 'grid' && custom ? '' : display;
          }
        };
        const setAttribute = (node, name, value) => {
          if (node !== null && isElement(node) && typeof node.setAttribute === 'function') {
            node.setAttribute(name, value);
          }
        };
        const copyDiagnostics = async () => {
          if (phase === 'destroyed') return false;
          const text = [uiMessage, uiDiagnostics]
            .map((value) => value?.trim())
            .filter((value) => value !== undefined && value.length > 0)
            .join('\\n\\n');
          let copied = false;
          try {
            const clipboard = host?.clipboard ?? globalThis.navigator?.clipboard;
            if (typeof clipboard?.writeText === 'function') {
              await clipboard.writeText(text);
              copied = true;
            }
          } catch {
            // Continue to the DOM fallback when clipboard permission is unavailable.
          }
          if (!copied) {
            try {
              const textarea = document.createElement?.('textarea');
              const parent = document.body ?? document.documentElement;
              if (textarea !== undefined && parent !== undefined && parent !== null) {
                textarea.value = text;
                textarea.setAttribute('readonly', '');
                textarea.style.position = 'fixed';
                textarea.style.left = '-10000px';
                parent.appendChild(textarea);
                try {
                  textarea.focus?.();
                  textarea.select();
                  copied = document.execCommand?.('copy') === true;
                } finally {
                  textarea.remove?.();
                }
              }
            } catch {
              copied = false;
            }
          }
          uiCopyStatus = copied ? 'copied' : 'failed';
          setText(fatalCopyStatus, copied ? 'Diagnostics copied.' : 'Could not copy diagnostics.');
          notifyUi();
          return copied;
        };
        const onCopyDiagnostics = () => {
          void copyDiagnostics();
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
          // Let focused startup buttons receive their default activation, but
          // stop the key event before it reaches gameplay while this surface owns the page.
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
          // A binding joins the current gate: an App bound after the first
          // ready frame (hot reload, a replacement App) is admitted at once,
          // and the game UI never falls back to inert behind no cover.
          setInputEnabled(inputEnabled);
          return () => {
            if (inputBinding !== callback) return;
            inputBinding = undefined;
            try {
              callback(false);
            } catch {
              // The retiring App may already be disposed.
            }
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
        let detailLayout;
        const showDetail = () => {
          if (loadingDetail === null || !isElement(loadingDetail)) return;
          setAttribute(loadingDetail, 'title', shownDetail);
          const summary = loadingDetail.parentElement;
          const layout = [shownDetail, summary?.clientWidth, loadingStatus?.scrollWidth, loadingMeta?.scrollWidth].join('|');
          if (layout === detailLayout) return;
          detailLayout = layout;
          showText(loadingDetail, shownDetail);
          if (!(loadingDetail.clientWidth > 0) || loadingDetail.scrollWidth <= loadingDetail.clientWidth) return;
          // Use portable DOM measurements: the native UI profile has no CSS text-overflow.
          const characters = Array.from(shownDetail);
          let low = 0, high = characters.length;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            showText(loadingDetail, characters.slice(0, middle).join('') + '…');
            if (loadingDetail.scrollWidth <= loadingDetail.clientWidth) low = middle;
            else high = middle - 1;
          }
          showText(loadingDetail, characters.slice(0, low).join('') + '…');
        };
        const showMeta = () => {
          showText(loadingMeta, shownPercent + '%' + (shownElapsed === '' ? '' : ' · ' + shownElapsed));
          showDetail();
          notifyUi();
        };
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
            if (bytes > 0) { shownDetail = megabytes(bytes); showDetail(); notifyUi(); }
          }
          elapsedTimer = setStartupTimeout(tickElapsed, 500);
        };
        const progress = (view) => {
          if (!gamePage || (phase !== 'loading' && phase !== 'preparing')) return;
          if (view === null || typeof view !== 'object') return;
          progressBound = true;
          lastView = view;
          shownActivity = typeof view.activity === 'string' ? view.activity : labels.loading;
          shownDetail = typeof view.detail === 'string' ? view.detail : '';
          showText(loadingStatus, shownActivity);
          if (Number.isFinite(view.percent)) showPercent(Math.max(0, Math.min(100, Math.floor(view.percent))));
          else { showDetail(); notifyUi(); }
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
          notifyUi();
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
          bindUiKeys();
          bindStartupInputCapture();
          bindFatalReload();
          bindFatalCopy();
          let details = formatStartupFailure(reason);
          const notice = fatal;
          const message = runtimeFailure ? 'The game stopped because execution failed.' : 'Unable to start the game.';
          if (/webgpu|adapter-unavailable|no usable (rendering )?backend/i.test(details)) {
            details += '\\n\\nRenderer diagnosis: ForgeAX supports browser WebGPU and a wgpu/WebGL2 fallback. This failure alone does not prove that WebGPU is unsupported; use the structured code, hint, and nested backend causes above.';
          }
          // Keep the existing plain-text diagnostic fallback for hosts that
          // provide only one synthetic HTMLElement in a test harness.
          if (notice !== null && fatalMessage === notice) {
            notice.textContent = (runtimeFailure ? 'ForgeAX game stopped.\\n' : 'ForgeAX game failed to start.\\n') + message + '\\n' + details;
          } else {
            setText(fatalMessage, message);
            setText(fatalDetails, details);
          }
          uiMessage = message;
          uiDiagnostics = details;
          console.warn?.('[ForgeAX game failure]', message, details);
          notifyUi();
          if (startupCache === undefined) disposeUi('loading');
          setDisplay(loading, 'none');
          setDisplay(notice, 'grid');
          setDisplay(fatalReload, 'inline-block');
          setAttribute(loading, 'aria-hidden', 'true');
          setAttribute(loading, 'data-fading', 'false');
          if (gamePage && fatalReload !== null && isElement(fatalReload)) fatalReload.focus?.();
          if (startupCache !== undefined) {
            void startupCache.recover(details, () => {
              // The native/dev startup oracle observes the fatal surface. Keep
              // recovery nonterminal until its single retry has really failed.
              uiRecovery = 'retrying';
              notifyUi();
              setDisplay(notice, 'none');
              setDisplay(loading, 'grid');
              setAttribute(loading, 'aria-hidden', 'false');
              setText(loadingStatus, 'Refreshing cached startup resources and retrying once…');
            }).then(result => {
              if (phase === 'destroyed') return;
              if (result.status === 'reloaded' || result.status === 'disabled') { disposeUi('loading'); return; }
              setDisplay(loading, 'none');
              setAttribute(loading, 'aria-hidden', 'true');
              setDisplay(notice, 'grid');
              setText(fatalMessage, message);
              if (result.status === 'exhausted') {
                uiRecovery = 'exhausted';
                uiDiagnostics = details + '\\n\\nAutomatic startup cache recovery was attempted once.' +
                  (result.previous ? '\\nFirst failure:\\n' + result.previous : '');
              } else if (result.status === 'failed') {
                uiRecovery = 'failed';
                uiDiagnostics = details + '\\n\\nStartup cache recovery failed: ' + result.error;
              }
              setText(fatalDetails, uiDiagnostics);
              notifyUi();
              disposeUi('loading');
            });
          }

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
          shownActivity = labels.phases['first-frame'] ?? labels.loading;
          notifyUi();
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
          startupCache?.complete();
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
            notifyUi();
            disposeUi('loading');
            setDisplay(loading, 'none');
            setAttribute(loading, 'data-fading', 'false');
            cleanupStartupListeners();
          }, fadeDurationMs);
        };
        const destroy = (releaseUi = true) => {
          if (phase === 'destroyed') return;
          sessionGeneration += 1;
          phase = 'destroyed';
          notifyUi();
          disposeUi('loading');
          disposeUi('failure');
          uiListeners.clear();
          startupCache?.retire();
          frameRate.destroy();
          setInputEnabled(false);
          // The retired startup owner no longer gates the page's UI.
          if (releaseUi && gamePage && isElement(gameUi)) gameUi.inert = false;
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
        // A page kept in the back/forward cache resumes as it was.
        const onPageHide = (event) => {
          if (event?.persisted !== true) destroy();
        };
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
        const bindUiKeys = () => {
          for (const root of [loading, fatal]) {
            root?.addEventListener?.('keydown', onStartupControlKey);
            root?.addEventListener?.('keyup', onStartupControlKey);
          }
        };
        bindUiKeys();
        const cleanupStartupListeners = () => {
          for (const root of [loading, fatal]) {
            root?.removeEventListener?.('keydown', onStartupControlKey);
            root?.removeEventListener?.('keyup', onStartupControlKey);
          }
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
          if (fatalCopy !== null && typeof fatalCopy.removeEventListener === 'function') {
            fatalCopy.removeEventListener('click', onCopyDiagnostics);
            fatalCopy.removeEventListener('keydown', onStartupControlKey);
            fatalCopy.removeEventListener('keyup', onStartupControlKey);
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
        const bindFatalCopy = () => {
          if (
            fatalCopy === null ||
            !isElement(fatalCopy) ||
            typeof fatalCopy.addEventListener !== 'function'
          ) return;
          fatalCopy.addEventListener('click', onCopyDiagnostics);
          fatalCopy.addEventListener('keydown', onStartupControlKey);
          fatalCopy.addEventListener('keyup', onStartupControlKey);
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
          ready: () => startupCache?.ready() ?? Promise.resolve(),
          prepare,
          enter,
          fail: show,
          destroy,
          bindInput,
          bindSession,
          submitted: (detail) => onSubmitted({ target: currentCanvas(), detail }),
          visibilityChanged: onVisibilityChange,
          progress,
          inspect: snapshotUi,
          onEntered,
        });
        ${(['loading', 'failure'] as const)
          .map((kind) => {
            const template = ui[kind];
            if (typeof template !== 'object' || template.script === undefined) return '';
            return `if (phase !== 'destroyed' && ${kind === 'loading' ? 'gamePage && loading !== null' : 'fatal !== null'}) {
            const root = ${kind === 'loading' ? 'loading' : 'fatal'};
            const ownedListeners = new Set();
            let retired = false;
            let cleanup;
            uiDisposers.set('${kind}', () => {
              retired = true;
              for (const listener of ownedListeners) uiListeners.delete(listener);
              ownedListeners.clear();
              cleanup?.();
            });
            try {
              cleanup = ((screen) => {\n${template.script.replace(/<\/script/gi, '<\\/script')}\n})(Object.freeze({
                kind: '${kind}', root, document, reload, copyDiagnostics,
                subscribe(listener) {
                  if (retired || typeof listener !== 'function') return () => {};
                  ownedListeners.add(listener); uiListeners.add(listener); listener(snapshotUi());
                  return () => { ownedListeners.delete(listener); uiListeners.delete(listener); };
                }
              }));
              if (typeof cleanup !== 'function') cleanup = undefined;
              if (retired) cleanup?.();
            } catch (error) {
              console.error('[ForgeAX startup UI mount]', error);
              disposeUi('${kind}');
            }
          }`;
          })
          .join('\n')}
        if (host === undefined) globalThis.__forgeaxStartup = startup;
        return startup;
      })(${hostExpression});
`;
}
