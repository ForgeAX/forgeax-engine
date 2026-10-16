import { writeBrowserClipboard } from '@forgeax/engine/host/platform';
const ENGINE_FATAL_ID = 'forgeax-fatal';
const BANNER_CLASS = 'fx-engine-fatal-banner';
const MESSAGE_CLASS = 'fx-engine-fatal-banner__message';
const ACTIONS_CLASS = 'fx-engine-fatal-banner__actions';

function fatalElement(document: Document | undefined) {
  if (!document) return null;
  return document.getElementById?.(ENGINE_FATAL_ID)
    ?? document.querySelector?.<HTMLElement>(`#${ENGINE_FATAL_ID}`)
    ?? null;
}

function resolveHost(host: HTMLElement | (() => HTMLElement | null) | undefined) {
  return typeof host === 'function' ? host() : host;
}

/** Canvas box: #app-shell wraps #app. Fall back to the View targets cell. */
function canvasHost(document: Document, fallback: HTMLElement | (() => HTMLElement | null) | undefined) {
  const canvas = document.querySelector?.('.fx-view-viewport-surface #app')
    ?? document.querySelector?.('#app');
  if (canvas?.parentElement) return canvas.parentElement;
  return document.querySelector?.<HTMLElement>('.fx-view-viewport-surface [data-forgeax-view-workspace="targets"]')
    ?? resolveHost(fallback);
}

function readFatalText(notice: HTMLElement | null) {
  return typeof notice?.textContent === 'string' ? notice.textContent.trim() : '';
}

/** Engine's generated overlay has no event. show() sets #forgeax-fatal text and inline display:grid. */
function isEngineFatalShown(notice: HTMLElement | null) {
  return notice?.style?.display === 'grid' && readFatalText(notice) !== '';
}

function button(document: Document, label: string, ariaLabel: string) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'fx-button fx-button--compact fx-button--quiet';
  node.textContent = label;
  node.setAttribute('aria-label', ariaLabel);
  return node;
}

function createBanner(document: Document, { onCopy, onClose }: { onCopy: (text: string, button: HTMLButtonElement) => void; onClose: () => void }) {
  const banner = document.createElement('div');
  banner.className = `${BANNER_CLASS} fx-ui`;
  banner.setAttribute('role', 'alert');
  banner.hidden = true;
  const message = document.createElement('pre');
  message.className = MESSAGE_CLASS;
  const actions = document.createElement('div');
  actions.className = ACTIONS_CLASS;
  const copy = button(document, 'Copy error', 'Copy the error reason');
  const close = button(document, 'Close', 'Dismiss the error banner');
  copy.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onCopy(message.textContent?.trim() ?? '', copy);
  });
  close.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClose();
  });
  actions.append(copy, close);
  banner.append(message, actions);
  return { banner, message, copy };
}

function placeBanner(banner: HTMLElement, host: HTMLElement | null | undefined) {
  if (!host || banner.parentNode === host) return;
  host.append?.(banner);
}

/**
 * Engine does not publish a fatal event. This watches the generated overlay
 * node: id=forgeax-fatal, inline style.display=grid, non-empty textContent.
 * The banner is View DOM, absolutely positioned on the canvas box.
 */
export function attachEngineFatalBanner({
  document = globalThis.document,
  host,
  writeClipboard = writeBrowserClipboard,
} : { document?: Document; host?: HTMLElement | (() => HTMLElement | null); writeClipboard?: (text: string) => Promise<void> } = {}) {
  if (!document?.createElement) return () => {};
  const { banner, message, copy } = createBanner(document, {
    onCopy(text, button) {
      if (!text) return;
      void writeClipboard(text).then(() => {
        button.textContent = 'Copied';
        setTimeout(() => {
          if (button.isConnected) button.textContent = 'Copy error';
        }, 2000);
      }).catch(error => { button.textContent = 'Copy failed'; button.title = String(error); });
    },
    onClose() {
      // Restore Engine's initial hidden overlay. Keep the node and its text;
      // show() looks it up by id and writes display:grid again.
      fatalElement(document)?.style?.removeProperty?.('display');
      banner.hidden = true;
    },
  });

  const sync = () => {
    placeBanner(banner, canvasHost(document, host));
    const notice = fatalElement(document);
    const text = readFatalText(notice);
    if (!isEngineFatalShown(notice)) {
      banner.hidden = true;
      return;
    }
    if (message.textContent !== text) message.textContent = text;
    if (copy.textContent !== 'Copy error') copy.textContent = 'Copy error';
    banner.hidden = false;
  };

  if (typeof MutationObserver !== 'function') {
    sync();
    return () => banner.remove?.();
  }

  const noticeObserver = new MutationObserver(sync);
  let observed: HTMLElement | null | undefined;
  const watchNotice = () => {
    const notice = fatalElement(document);
    if (!notice || notice === observed) {
      sync();
      return;
    }
    observed = notice;
    noticeObserver.observe(notice, {
      attributes: true,
      attributeFilter: ['style'],
      childList: true,
      subtree: true,
      characterData: true,
    });
    sync();
  };

  watchNotice();
  const root = document.documentElement ?? document.body;
  const rootObserver = root ? new MutationObserver(watchNotice) : undefined;
  if (root) rootObserver?.observe(root, { childList: true, subtree: true });
  return () => {
    noticeObserver.disconnect();
    rootObserver?.disconnect();
    banner.remove?.();
  };
}
