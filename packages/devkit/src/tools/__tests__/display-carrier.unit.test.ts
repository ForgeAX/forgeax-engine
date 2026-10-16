import type { Frame } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireBrowserCarrierPage,
  assertBrowserCarrierAttachment,
  assertBrowserCarrierSurface,
  type BrowserCarrierAdapter,
  type BrowserCarrierAttachment,
  type BrowserCarrierLeaseSelection,
  type BrowserCarrierRequest,
} from '../display-carrier.js';

const target = {
  leaseId: 'carrier-lease-1',
  targetId: 'carrier-target-1',
  kind: 'browser-page',
  surfaceId: 'carrier-surface-1',
  run: { serviceId: 'service-1', runId: 'run-1' },
  generation: 3,
  width: 640,
  height: 360,
  gpu: 'auto' as const,
};

const request: BrowserCarrierRequest = {
  run: target.run,
  generation: target.generation,
  headless: false,
  gpu: 'auto',
  width: target.width,
  height: target.height,
  url: 'http://127.0.0.1:43125/',
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function borrowedSelection(
  release: (reason?: string) => Promise<void>,
): BrowserCarrierLeaseSelection {
  return { carrier: 'borrowed', target, release };
}

function attachment(close: (reason?: string) => Promise<void>): BrowserCarrierAttachment {
  const page = {
    goto: vi.fn(),
    evaluate: vi.fn(),
    locator: vi.fn(),
    waitForFunction: vi.fn(),
    waitForTimeout: vi.fn(),
  } as unknown as BrowserCarrierAttachment['page'];
  return { page, target, execution: { kind: 'page', ownerPage: page, realm: page }, close };
}

describe('display carrier acquisition cancellation', () => {
  it('does not select a carrier when the request is already aborted', async () => {
    const select = vi.fn();
    const controller = new AbortController();
    const reason = new Error('request-cancelled');
    controller.abort(reason);

    await expect(
      acquireBrowserCarrierPage(
        { select, attach: vi.fn() } as unknown as BrowserCarrierAdapter,
        request,
        { signal: controller.signal, releaseReason: 'request-cancelled' },
      ),
    ).rejects.toBe(reason);
    expect(select).not.toHaveBeenCalled();
  });

  it('releases a selection that arrives after cancellation and never attaches it', async () => {
    const selected = deferred<BrowserCarrierLeaseSelection>();
    const release = vi.fn(async () => undefined);
    const attach = vi.fn();
    const controller = new AbortController();
    const reason = new Error('selection-cancelled');
    const operation = acquireBrowserCarrierPage(
      {
        select: vi.fn(async () => selected.promise),
        attach,
      } as unknown as BrowserCarrierAdapter,
      request,
      { signal: controller.signal, releaseReason: 'selection-cancelled' },
    );

    controller.abort(reason);
    selected.resolve(borrowedSelection(release));

    await expect(operation).rejects.toBe(reason);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith('selection-cancelled');
    expect(attach).not.toHaveBeenCalled();
  });

  it('closes an attachment that arrives after cancellation and does not navigate with it', async () => {
    const attached = deferred<BrowserCarrierAttachment>();
    const release = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const attach = vi.fn(async () => attached.promise);
    const controller = new AbortController();
    const reason = new Error('attachment-cancelled');
    const operation = acquireBrowserCarrierPage(
      {
        select: vi.fn(async () => borrowedSelection(release)),
        attach,
      } as unknown as BrowserCarrierAdapter,
      request,
      { signal: controller.signal, releaseReason: 'attachment-cancelled' },
    );

    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    controller.abort(reason);
    attached.resolve(attachment(close));

    await expect(operation).rejects.toBe(reason);
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith('attachment-cancelled');
    expect(release).not.toHaveBeenCalled();
  });

  it('validates a stable owner page distinct from an explicit execution frame', () => {
    const ownerPage = {
      goto: vi.fn(),
      evaluate: vi.fn(),
      locator: vi.fn(),
      waitForFunction: vi.fn(),
      waitForTimeout: vi.fn(),
    } as unknown as BrowserCarrierAttachment['page'];
    const frame = {
      goto: vi.fn(),
      evaluate: vi.fn(),
      locator: vi.fn(),
      waitForFunction: vi.fn(),
      waitForTimeout: vi.fn(),
      page: vi.fn(() => ownerPage),
    } as unknown as Frame;
    const close = vi.fn(async () => undefined);
    const validated = assertBrowserCarrierAttachment({
      page: ownerPage,
      target,
      execution: { kind: 'frame', ownerPage, realm: frame, surfaceSelector: '#carrier-surface-1' },
      close,
    });

    expect(validated.page).toBe(ownerPage);
    expect(validated.execution.kind).toBe('frame');
    expect(validated.execution.ownerPage).toBe(ownerPage);
    expect(validated.execution.realm).toBe(frame);
  });

  it.each([
    true,
    false,
  ])('checks exact iframe identity without product DOM attributes (matching=%s)', async (matching) => {
    const realm = {} as Frame;
    const ownerPage = {
      goto: vi.fn(),
      evaluate: vi.fn(),
      locator: vi.fn(() => ({
        count: vi.fn(async () => 1),
        elementHandle: vi.fn(async () => ({
          evaluate: vi.fn(async () => ({
            tagName: 'IFRAME',
            id: target.surfaceId,
          })),
          contentFrame: vi.fn(async () => (matching ? realm : ({} as Frame))),
          dispose: vi.fn(async () => undefined),
        })),
      })),
      waitForFunction: vi.fn(),
      waitForTimeout: vi.fn(),
    } as unknown as BrowserCarrierAttachment['page'];
    const frame = {
      goto: vi.fn(),
      evaluate: vi.fn(),
      locator: vi.fn(),
      waitForFunction: vi.fn(),
      waitForTimeout: vi.fn(),
      page: vi.fn(() => ownerPage),
    } as unknown as Frame;
    const close = vi.fn(async () => undefined);
    const attachmentValue = {
      page: ownerPage,
      target,
      execution: {
        kind: 'frame' as const,
        ownerPage,
        realm: matching ? realm : frame,
        surfaceSelector: '#carrier-surface-1',
      },
      close,
    };
    if (matching)
      await expect(assertBrowserCarrierSurface(attachmentValue)).resolves.toBeUndefined();
    else
      await expect(assertBrowserCarrierSurface(attachmentValue)).rejects.toThrow(
        'does not own its execution realm',
      );
  });
});
