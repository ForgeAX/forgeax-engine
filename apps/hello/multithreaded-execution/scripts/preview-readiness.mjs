import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export async function waitForPreview(server, timeoutMs = 15_000) {
  const index = resolve(server.config.root, server.config.build.outDir, 'index.html');
  if (!existsSync(index)) {
    throw new Error(
      `preview executable input missing: ${index}; app-dist transfer contains shader/Pack inputs only; build the app before browser assertions`,
    );
  }
  const url = server.resolvedUrls.local[0];
  const deadline = Date.now() + timeoutMs;
  let lastResponse = 'no response';
  let lastTransportError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      await response.body?.cancel();
      if (response.ok) return;
      if (!lastResponse.startsWith('HTTP ')) {
        lastResponse = `HTTP ${response.status} ${response.statusText}`;
      }
    } catch (error) {
      lastTransportError = `${error.message}; cause=${error.cause?.code ?? error.name}`;
    }
    await new Promise((done) => setTimeout(done, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(
    `preview readiness failed: url=${url} index=${index} timeoutMs=${timeoutMs} lastResponse=${lastResponse}${lastTransportError ? `; lastTransportError=${lastTransportError}` : ''}`,
  );
}

/** Browser-side predicate shared by the smoke and its readiness regression. */
export function executionSmokeReady(tier) {
  if (globalThis.__forgeaxExecutionReady !== true) return false;
  if (tier !== 'shared' && tier !== 'auto') return true;
  // Cold pool Workers may join after the first safe inline update. Observe
  // the same published snapshot that the smoke's dispatch assertion reads.
  const report = JSON.parse(document.querySelector('#execution-report')?.textContent ?? 'null');
  return report?.kernelDispatch?.usedShared === true;
}
