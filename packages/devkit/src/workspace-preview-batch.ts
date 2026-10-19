import { THUMBNAIL_PREVIEW } from '@forgeax/engine-preview';
import { type Browser, chromium, type Page } from 'playwright';
import { browserLaunchArgs, resolveBrowserExecutable } from './browser-capture.js';

export interface PreviewImageCapture {
  readonly dataUrl: string;
  readonly preparedMs: number;
  readonly totalMs: number;
  readonly submitted: number;
  readonly ready: number;
}
interface PreviewBatchPage {
  ready: boolean;
  error?: { code: string; expected: string; hint: string };
  capture(input: {
    asset: { guid: string; kind: string };
    input: string;
  }): Promise<PreviewImageCapture>;
  dispose(): Promise<void>;
}

/** Lazy browser carrier; one page retains GPU, pipelines and assets across image leases. */
export function createWorkspacePreviewBatch(url: string) {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let closed = false;
  let opening: Promise<Page> | undefined;
  async function open(): Promise<Page> {
    const channel = process.env.FORGEAX_CHROME_CHANNEL;
    const executablePath = channel ? undefined : await resolveBrowserExecutable(undefined);
    browser = await chromium.launch({
      headless: true,
      ...(channel ? { channel } : {}),
      ...(executablePath ? { executablePath } : {}),
      args: browserLaunchArgs(
        process.env.FORGEAX_THUMBNAIL_BACKEND === 'software' ? 'software' : 'hardware',
        'development',
        false,
      ),
      chromiumSandbox: true,
    });
    if (closed) {
      await browser.close();
      throw new Error('Preview batch retired');
    }
    page = await browser.newPage({
      viewport: { width: THUMBNAIL_PREVIEW.size, height: THUMBNAIL_PREVIEW.size },
    });
    page.setDefaultTimeout(45_000);
    await page.goto(new URL('/preview-batch.html', url).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        (globalThis as typeof globalThis & { __forgeaxPreviewBatch?: PreviewBatchPage })
          .__forgeaxPreviewBatch?.ready,
    );
    const error = await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { __forgeaxPreviewBatch: PreviewBatchPage })
          .__forgeaxPreviewBatch.error,
    );
    if (error) throw Object.assign(new Error(error.hint), error);
    return page;
  }
  const close = async (): Promise<void> => {
    closed = true;
    // Retiring the process also cancels stalled page evaluation and asset loading.
    await browser?.close();
  };
  return {
    async capture(
      asset: { guid: string; kind: string },
      input: string,
      signal: AbortSignal,
    ): Promise<PreviewImageCapture> {
      signal.throwIfAborted();
      if (closed) throw new Error('Preview batch retired');
      const retire = () => {
        void close();
      };
      const deadline = setTimeout(retire, 90_000);
      signal.addEventListener('abort', retire, { once: true });
      try {
        opening ??= open();
        const active = await opening;
        signal.throwIfAborted();
        const captured = await active.evaluate(
          async (request) => {
            try {
              return {
                ok: true as const,
                value: await (
                  globalThis as typeof globalThis & { __forgeaxPreviewBatch: PreviewBatchPage }
                ).__forgeaxPreviewBatch.capture(request),
              };
            } catch (cause) {
              return {
                ok: false as const,
                error:
                  JSON.stringify(cause, (_key, value) =>
                    value instanceof Error
                      ? { ...value, name: value.name, message: value.message }
                      : value,
                  ) || String(cause),
              };
            }
          },
          { asset, input },
        );
        signal.throwIfAborted();
        if (!captured.ok) throw new Error(captured.error);
        return captured.value;
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener('abort', retire);
      }
    },
    close,
  };
}
