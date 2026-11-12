import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareWgpuProductionFixture(inline: boolean): Promise<{ url: string; fingerprint: string }>;
    releaseWgpuProductionFixture(): Promise<void>;
  }
}

it.each([
  true,
  false,
])('loads real production WASM in a Worker with connect-src excluding data: (inline=%s)', async (inline) => {
  const { url, fingerprint } = await commands.prepareWgpuProductionFixture(inline);
  const frame = document.createElement('iframe');
  let receive: (event: MessageEvent) => void = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = new Promise<unknown>((resolve, reject) => {
      receive = (event) => {
        if (event.source === frame.contentWindow && event.origin === new URL(url).origin)
          resolve(event.data);
      };
      window.addEventListener('message', receive);
      timeout = setTimeout(() => reject(new Error('Production Worker did not finish')), 15_000);
    });
    frame.src = url;
    document.body.append(frame);
    expect(await result).toEqual({
      ok: true,
      fingerprint,
      singleton: true,
      hasRhi: true,
      dataProbe: 'TypeError',
    });
  } finally {
    clearTimeout(timeout);
    window.removeEventListener('message', receive);
    frame.remove();
    await commands.releaseWgpuProductionFixture();
  }
}, 60_000);
