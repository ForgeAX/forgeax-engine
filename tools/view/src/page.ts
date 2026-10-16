import type { Page } from 'playwright';
import type { Context } from '@forgeax/engine-plugin';
/** Wait only for View UI mounting; target readiness is a separate Engine operation. */
export async function waitForLiveViewerShell(page: Page, { timeout = 30_000 }: { timeout?: number } = {}) {
  await page.waitForFunction(() => {
    const ready = globalThis.__forgeaxViewReady;
    if (ready?.error) throw new Error(ready.error);
    return !!ready?.mounted;
  }, undefined, { timeout });
}

/** Attach an explicitly supplied Page to an already-serving View URL. */
export async function attachViewPage({ page, url, timeout }: { page?: Page; url?: string; timeout?: number } = {}) {
  if (!page || typeof page.goto !== 'function') throw new TypeError('View requires an already-open owner Page');
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new TypeError('View requires the issued interface URL');
  const target = new URL(url).href;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (!page.isClosed() && page.url() === target) await page.goto('about:blank');
  };
  try {
    await page.goto(target);
    await waitForLiveViewerShell(page, { timeout });
    return { dispose };
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}

export default {
  name: 'forgeax.view.page',
  provide: 'viewPage',
  async apply(ctx: Context, options: Parameters<typeof attachViewPage>[0]) {
    const page = await attachViewPage(options);
    ctx.effect(() => () => page.dispose());
    ctx.provide('viewPage', page);
  },
};
