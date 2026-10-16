import type { Page, Frame } from 'playwright';
import type { CarrierCapabilities, CreatePageInput, ViewPlatform, ViewPlatformPage } from '@forgeax/view-plugin-display/carrier-contract';
import { workspaceDiagnosticRecord } from '@forgeax/view-workspace-core/command-error';
export type BrowserPagePlatformOptions = { page?: Page; targetId?: string; kind?: string; capabilities?: Partial<CarrierCapabilities> };
type BrowserPageResource = ViewPlatformPage & { leaseId: string; generation: number; requestedCanvasSize: Readonly<{ width: number; height: number }>; dispose: () => Promise<void>; onClose?: () => void; onFrameDetached?: (frame: Frame) => void };

/**
 * Adapt a browser Page that is already owned by the embedding application.
 *
 * This adapter deliberately does not import a browser launcher and never
 * creates or closes a browser. The owner supplies the exact stable shell Page
 * (normally a Playwright Page) before Engine asks View for a lease. Each lease
 * receives one fixed child iframe; Engine navigates that Frame, while View
 * keeps the owner Page and shell alive for the whole lease.
 */
export class BrowserPagePlatform implements ViewPlatform {
  declare readonly page: Page;
  declare readonly targetId: string;
  declare readonly kind: string;
  declare readonly capabilityOverrides: Partial<CarrierCapabilities>;
  declare active: BrowserPageResource | null;
  declare disposed: boolean;
  constructor({
    page,
    targetId = 'view-browser-page',
    kind = 'browser-page',
    capabilities = {},
  }: BrowserPagePlatformOptions = {}) {
    assertPage(page);
    if (typeof targetId !== 'string' || targetId.length === 0) {
      throw new TypeError('browser page targetId must be a non-empty string');
    }
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new TypeError('browser page kind must be a non-empty string');
    }
    this.page = page;
    this.targetId = targetId;
    this.kind = kind;
    this.capabilityOverrides = { ...capabilities };
    this.active = null;
    this.disposed = false;
  }

  getCapabilities(): Partial<CarrierCapabilities> {
    const ready = !this.disposed && !pageIsClosed(this.page);
    return {
      // `auto` is the only honest default. An embedding browser owner may
      // add hardware/software after it has probed the actual adapter.
      maxWidth: 8192,
      maxHeight: 8192,
      canvasSizing: 'fixed',
      ...this.capabilityOverrides,
      ready: ready && (this.capabilityOverrides.ready ?? true),
      supportsPage: ready && (this.capabilityOverrides.supportsPage ?? true),
      gpuModes: [...(this.capabilityOverrides.gpuModes ?? ['auto'])],
    };
  }

  async createPage({ leaseId, generation, width, height, signal, onLost }: Partial<CreatePageInput> = {}): Promise<BrowserPageResource> {
    if (typeof leaseId !== 'string' || leaseId.length === 0) {
      throw new TypeError('browser page leaseId must be a non-empty string');
    }
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) {
      throw new TypeError('browser page generation must be a non-negative safe integer');
    }
    assertDimension(width, 'width');
    assertDimension(height, 'height');
    throwIfAborted(signal);
    if (this.disposed || pageIsClosed(this.page)) {
      throw Object.assign(new Error('the supplied browser page is no longer available'), {
        fallbackReason: 'view-target-lost',
      });
    }
    if (this.active !== null) {
      throw Object.assign(new Error('the supplied browser page is already leased'), {
        fallbackReason: 'view-occupied',
      });
    }

    const surfaceId = 'forgeax-view-display-surface';
    const surfaceSelector = `#${surfaceId}`;
    try {
      await this.page.waitForFunction(
        (id) => document.getElementById(id)?.tagName === 'IFRAME',
        surfaceId,
        { timeout: 15_000 },
      );
      await this.page.evaluate(({ surfaceId, leaseId, generation, targetId }) => {
        const surface = document.getElementById(surfaceId) as HTMLIFrameElement | null;
        if (!surface || surface.tagName !== 'IFRAME') {
          throw new Error(`the display Frontend Fiber iframe is unavailable: ${surfaceId}`);
        }
        if (surface.name !== surfaceId) {
          throw new Error(`the display Frontend Fiber iframe has an invalid name: ${surface.name}`);
        }
        surface.dataset.forgeaxViewSurface = 'engine-target';
        surface.dataset.forgeaxViewTargetId = String(targetId);
        surface.dataset.forgeaxViewLeaseId = String(leaseId);
        surface.dataset.forgeaxViewGeneration = String(generation);
        surface.setAttribute('aria-hidden', 'true');
        surface.style.display = 'block';
        surface.style.visibility = 'hidden';
        surface.style.pointerEvents = 'none';
        surface.style.border = '0';
        surface.style.width = '100%';
        surface.style.height = '100%';
      }, { surfaceId, leaseId, generation, targetId: this.targetId });
      let frame = this.page.frame({ name: surfaceId });
      if (!frame) {
        await this.page.waitForFunction(
          (id) => document.getElementById(id)?.tagName === 'IFRAME',
          surfaceId,
          { timeout: 15_000 },
        );
        frame = this.page.frame({ name: surfaceId });
      }
      if (!frame) {
        throw Object.assign(
          new Error('the allocated display iframe did not expose its execution frame'),
          { fallbackReason: 'view-target-lost' },
        );
      }

      const resource: BrowserPageResource = {
        leaseId,
        generation,
        targetId: this.targetId,
        kind: this.kind,
        surfaceId,
        page: this.page,
        execution: {
          kind: 'frame',
          ownerPage: this.page,
          realm: frame,
          surfaceSelector,
        },
        requestedCanvasSize: Object.freeze({ width, height }),
        dispose: async () => {
          if (this.active !== resource) return;
          this.detachPageListeners(resource);
          // The lease owns this Frame's document. Stop its bridge and runtime
          // before making the carrier available to a replacement run.
          if (typeof frame!.goto === 'function') await frame!.goto('about:blank').catch(() => {});
          await this.page
            .evaluate((id) => {
              const surface = document.getElementById(id);
              if (!surface) return;
              delete surface.dataset.forgeaxViewTargetId;
              delete surface.dataset.forgeaxViewLeaseId;
              delete surface.dataset.forgeaxViewGeneration;
              surface.style.visibility = 'hidden';
              surface.style.pointerEvents = 'none';
            }, surfaceId)
            .catch(() => {});
          if (this.active === resource) this.active = null;
        },
      };
      const onClose = () => {
        if (this.active !== resource) return;
        this.detachPageListeners(resource);
        this.active = null;
        onLost?.('browser-page-closed');
      };
      const onFrameDetached = (detachedFrame: Frame) => {
        if (this.active !== resource || detachedFrame !== frame) return;
        this.detachPageListeners(resource);
        this.active = null;
        onLost?.('browser-frame-detached');
      };
      resource.onClose = onClose;
      resource.onFrameDetached = onFrameDetached;
      this.active = resource;
      this.attachPageListeners(resource);
      if (signal?.aborted) {
        await resource.dispose();
        throwIfAborted(signal);
      }
      return resource;
    } catch (error) {
      throw error;
    }
  }

  detachPageListeners(resource: BrowserPageResource) {
    if (typeof this.page.off !== 'function') return;
    const listener = resource.onClose;
    if (listener === undefined) return;
    this.page.off('close', listener);
    this.page.off('crash', listener);
    if (resource.onFrameDetached !== undefined) this.page.off('framedetached', resource.onFrameDetached);
  }

  attachPageListeners(resource: BrowserPageResource) {
    if (typeof this.page.on !== 'function') return;
    if (!resource.onClose) return;
    this.page.on('close', resource.onClose);
    this.page.on('crash', resource.onClose);
    if (resource.onFrameDetached !== undefined) this.page.on('framedetached', resource.onFrameDetached);
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const active = this.active;
    if (active !== null) await active.dispose();
  }
}

function assertPage(value: unknown): asserts value is Page {
  if (!value || typeof value !== 'object') throw new TypeError('an existing browser page is required');
  const page = workspaceDiagnosticRecord(value);
  if (
    typeof page.goto !== 'function' ||
    typeof page.evaluate !== 'function' ||
    typeof page.locator !== 'function' ||
    typeof page.frame !== 'function' ||
    typeof page.waitForFunction !== 'function' ||
    typeof page.waitForTimeout !== 'function'
  ) {
    throw new TypeError(
      'the supplied browser page must provide goto, evaluate, locator, frame, waitForFunction, and waitForTimeout',
    );
  }
}

function pageIsClosed(page: Page) {
  return typeof page.isClosed === 'function' && page.isClosed();
}

function assertDimension(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = signal.reason ?? new Error('browser page allocation was cancelled');
  if (error instanceof Error && error.name === 'AbortError') throw error;
  if (error instanceof Error) {
    error.name = 'AbortError';
    throw error;
  }
  throw Object.assign(new Error('browser page allocation was cancelled'), {
    name: 'AbortError',
    cause: error,
  });
}

export function createBrowserPagePlatform(options?: BrowserPagePlatformOptions) {
  return new BrowserPagePlatform(options);
}
