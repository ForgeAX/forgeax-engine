import {
  DEFAULT_LOAD_PROGRESS_LABELS,
  encodeBase64,
  type LoadProgressLabels,
} from '@forgeax/engine-types';
import forgeaxLogo from './forgeax-logo.svg';

const FORGEAX_LOGO_SOURCE = forgeaxLogo.startsWith('<')
  ? `data:image/svg+xml;base64,${encodeBase64(new TextEncoder().encode(forgeaxLogo))}`
  : forgeaxLogo;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Default Engine startup presentation shared by browser and native hosts. */
export const STARTUP_COVER_STYLES = `
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
`;

/** Render the cover without owning a host, session, or input gate. */
export function renderStartupCover(
  title: string,
  labels: LoadProgressLabels = DEFAULT_LOAD_PROGRESS_LABELS,
  status = labels.phases['engine-code'] ?? labels.loading,
): string {
  return `    <div id="forgeax-loading" role="status" aria-live="polite" aria-atomic="true">
      <div id="forgeax-loading-content">
        <h1 id="forgeax-loading-title">${escapeHtml(title)}</h1>
        <div id="forgeax-loading-progress-content">
          <div id="forgeax-loading-row">
            <div id="forgeax-loading-brand">
              <img id="forgeax-loading-logo" src="${escapeHtml(FORGEAX_LOGO_SOURCE)}" alt="" aria-hidden="true" />
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
`;
}
