import {
  type PlaywrightBrowserProvider,
  type PlaywrightProviderOptions,
  playwright as playwrightProvider,
} from '@vitest/browser-playwright';
import type { BrowserContext, Page, Request, Response } from 'playwright';
import type { BrowserProviderOption, TestProject } from 'vitest/node';

// Vitest's Playwright provider creates each page with context.newPage(). Chrome
// activates the app for that operation in headed runs. The CDP target option
// keeps the same visible, Playwright-controlled page while preventing that
// OS-level activation on every Chromium host; the test document remains
// visible and focused.
type OpenBrowserOptions = { parallel: boolean };

type ProviderInternals = {
  createContext: (sessionId: string, options: OpenBrowserOptions) => Promise<BrowserContext>;
};

function isFalse(value: string | undefined): boolean {
  return value === '0' || value?.toLowerCase() === 'false';
}

async function browserContextIds(provider: PlaywrightBrowserProvider): Promise<Set<string>> {
  const browser = provider.browser;
  if (!browser) return new Set();
  const cdp = await browser.newBrowserCDPSession();
  try {
    const result = await cdp.send('Target.getBrowserContexts');
    return new Set(result.browserContextIds);
  } finally {
    await cdp.detach();
  }
}

async function createBackgroundPage(
  provider: PlaywrightBrowserProvider,
  context: BrowserContext,
  contextId: string,
): Promise<Page> {
  const browser = provider.browser;
  if (!browser) throw new Error('Playwright browser is not available.');

  const cdp = await browser.newBrowserCDPSession();
  let listener: ((page: Page) => void) | undefined;
  const pagePromise = new Promise<Page>((resolve) => {
    listener = (page) => {
      if (listener) context.off('page', listener);
      resolve(page);
    };
    context.on('page', listener);
  });
  try {
    await cdp.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId: contextId,
      background: true,
    });
    return await pagePromise;
  } catch (error) {
    if (listener) context.off('page', listener);
    throw error;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

function installBackgroundPageCreation(provider: PlaywrightBrowserProvider): void {
  const internals = provider as unknown as ProviderInternals;
  const originalCreateContext = internals.createContext;
  if (typeof originalCreateContext !== 'function') return;
  const createContext = originalCreateContext.bind(provider);
  const backgroundContexts = new WeakSet<BrowserContext>();
  let createContextQueue = Promise.resolve();

  internals.createContext = (sessionId, options) => {
    const run = createContextQueue.then(async () => {
      const before = await browserContextIds(provider);
      const context = await createContext(sessionId, options);
      if (backgroundContexts.has(context)) return context;

      const after = await browserContextIds(provider);
      const contextId = [...after].find((id) => !before.has(id));
      if (!contextId) return context;

      const originalNewPage = context.newPage.bind(context);
      context.newPage = async () => {
        try {
          return await createBackgroundPage(provider, context, contextId);
        } catch {
          // Keep the provider usable with a Chromium build that does not
          // implement Target.createTarget(background). The normal Playwright
          // path preserves the test result; only the focus optimization is
          // unavailable in that fallback.
          return originalNewPage();
        }
      };
      backgroundContexts.add(context);
      return context;
    });
    createContextQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

function installFailedModuleDiagnostics(provider: PlaywrightBrowserProvider): void {
  const internals = provider as unknown as ProviderInternals;
  const originalCreateContext = internals.createContext;
  if (typeof originalCreateContext !== 'function') return;
  const createContext = originalCreateContext.bind(provider);
  const installed = new WeakSet<BrowserContext>();

  internals.createContext = async (sessionId, options) => {
    const context = await createContext(sessionId, options);
    if (installed.has(context)) return context;
    installed.add(context);
    let failures = 0;
    const requestDetail = (request: Request) => ({
      url: request.url().slice(0, 4096),
      method: request.method().slice(0, 32),
      resourceType: request.resourceType(),
    });
    const responses = new WeakMap<
      Request,
      { response: Response; detail: ReturnType<typeof requestDetail>; status: number }
    >();
    const isModule = (request: Request) =>
      request.resourceType() === 'script' ||
      /\.browser\.test\.[cm]?[jt]sx?(?:$|[?#])/.test(request.url());
    const emit = (detail: Record<string, unknown>) => {
      try {
        process.stderr.write(
          `[browser-module-failure] ${JSON.stringify({
            pid: process.pid,
            installedForSessionId: sessionId.slice(0, 256),
            ...detail,
          })}\n`,
        );
      } catch {
        // Diagnostic output must not replace the original browser failure.
      }
    };
    context.on('requestfailed', (request) => {
      try {
        if (!isModule(request) || failures >= 32) return;
        failures++;
        emit({
          kind: 'requestfailed',
          ...requestDetail(request),
          errorText: request.failure()?.errorText.slice(0, 1024) ?? null,
          status: 'UNOBSERVED',
          bodyState: 'UNOBSERVED',
        });
      } catch {
        // A disposed request has no additional trustworthy diagnostics.
      }
    });
    context.on('response', (response) => {
      try {
        const request = response.request();
        if (response.status() < 400 || !isModule(request) || failures >= 32) return;
        failures++;
        const detail = requestDetail(request);
        const status = response.status();
        responses.set(request, { response, detail, status });
        const headers = response.headers();
        emit({
          kind: 'http-error',
          ...detail,
          status,
          contentType: headers['content-type']?.slice(0, 512) ?? null,
          contentLength: headers['content-length']?.slice(0, 32) ?? null,
          contentEncoding: headers['content-encoding']?.slice(0, 64) ?? null,
          bodyState: 'UNOBSERVED',
        });
      } catch {
        // Preserve the test result when the context closes during delivery.
      }
    });
    context.on('requestfinished', (request) => {
      const pending = responses.get(request);
      if (!pending) return;
      responses.delete(request);
      const { response, detail, status } = pending;
      void (async () => {
        const headers = response.headers();
        const rawLength = headers['content-length'];
        const length = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : NaN;
        const encoding = headers['content-encoding']?.trim().toLowerCase();
        if (
          !Number.isSafeInteger(length) ||
          length > 65_536 ||
          (encoding && encoding !== 'identity')
        ) {
          emit({
            kind: 'http-error-body',
            ...detail,
            status,
            bodyState: 'UNOBSERVED',
            reason: 'representation-size-not-bounded',
          });
          return;
        }
        const bytes = await response.body();
        emit({
          kind: 'http-error-body',
          ...detail,
          status,
          bodyState: 'OBSERVED',
          bodyUtf8: bytes.subarray(0, 16_384).toString('utf8'),
          bodyBytes: bytes.length,
          truncated: bytes.length > 16_384,
        });
      })().catch(() => {
        emit({
          kind: 'http-error-body',
          ...detail,
          status,
          bodyState: 'UNOBSERVED',
          reason: 'body-read-failed-or-context-closed',
        });
      });
    });
    return context;
  };
}

export function playwrightWithBackgroundPages(
  options: PlaywrightProviderOptions = {},
): BrowserProviderOption<PlaywrightProviderOptions> {
  const base = playwrightProvider(options);
  return {
    ...base,
    providerFactory(project: TestProject) {
      const provider = base.providerFactory(project) as PlaywrightBrowserProvider;
      const backgroundPages =
        project.config.browser.name === 'chromium' &&
        project.config.browser.headless === false &&
        !isFalse(process.env.FORGEAX_BROWSER_BACKGROUND);
      if (backgroundPages) installBackgroundPageCreation(provider);
      installFailedModuleDiagnostics(provider);
      return provider;
    },
  };
}
