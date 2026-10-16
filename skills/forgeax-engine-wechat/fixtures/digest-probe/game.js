import { digestBytesAsync } from '@probe/real-digest';
import { inputs } from '@probe/digest-inputs';

const describeError = error => ({ name: error?.name, message: error?.message ?? String(error) });
const facts = () => ({ cryptoType: typeof globalThis.crypto,
  subtleType: typeof globalThis.crypto?.subtle,
  digestType: typeof globalThis.crypto?.subtle?.digest,
  selected: globalThis.crypto?.subtle === undefined ? 'js' : 'webcrypto' });
let report = { phase: 'ready', source: inputs.source, clock: 'Date.now', timeoutMs: 2000, results: [] };

async function sample(mode, bytes, expected) {
  const observed = facts();
  const started = Date.now();
  let timer;
  let promise;
  if (mode === 'fallback') {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    if (descriptor && !descriptor.configurable && !descriptor.writable)
      return { mode, size: bytes.length, observed, status: 'unsupported', error: 'crypto cannot be temporarily shadowed' };
    try {
      Object.defineProperty(globalThis, 'crypto', descriptor && !descriptor.configurable
        ? { value: undefined } : { value: undefined, writable: true, configurable: true });
      // The real async owner reads crypto before its first await. Restore the
      // host immediately; do not substitute a second hashing implementation.
      promise = digestBytesAsync(bytes);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else delete globalThis.crypto;
    }
  } else promise = digestBytesAsync(bytes);
  try {
    const result = await Promise.race([
      promise.then(digest => ({ status: 'completed', digest, matches: digest === expected }),
        error => ({ status: 'failed', error: describeError(error) })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'timeout' }), report.timeoutMs); }),
    ]);
    const elapsedMs = Date.now() - started;
    return { mode, size: bytes.length, observed,
      selected: mode === 'fallback' ? 'js' : observed.selected,
      elapsedMs, overBudget: elapsedMs > report.timeoutMs, ...result };
  } finally { clearTimeout(timer); }
}

async function run() {
  const timerStart = Date.now();
  await new Promise(resolve => setTimeout(resolve, 0));
  report.timerYieldMs = Date.now() - timerStart;
  for (const mode of ['natural', 'fallback']) {
    for (const entry of inputs.cases) {
      const bytes = new Uint8Array(entry.size);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 17) & 255;
      report.results.push(await sample(mode, bytes, entry.digest));
    }
  }
  report.phase = 'complete';
  report.passed = report.results.every(row => row.status === 'completed' && row.matches && !row.overBudget);
  console.info('[forgeax.digest-probe]', JSON.stringify(report));
}

globalThis.__forgeaxDigestProbe = {
  read: () => JSON.parse(JSON.stringify(report)),
  start() {
    if (report.phase !== 'ready') return this.read();
    report.phase = 'running';
    void run().catch(error => { report.phase = 'failed'; report.error = describeError(error); });
    return this.read();
  },
};
console.info('[forgeax.digest-probe.ready]', JSON.stringify({ source: inputs.source, ...facts() }));
