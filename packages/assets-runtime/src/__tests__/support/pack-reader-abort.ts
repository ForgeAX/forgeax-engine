import { PackReader } from '../../internal/pack-reader.js';

export async function readPackWithoutNativeAny() {
  const url = 'https://fixture.test/value.pack.json';
  const tuple = { scopeId: 'test', generation: 1, digest: 'test', outputSetDigest: 'test' };
  const pack = { ...tuple, schemaVersion: '2.0.0', kind: 'internal-text-package', assets: [] };
  let calls = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const reader = new PackReader({
    fetcher: async () => {
      calls++;
      await gate;
      return new Response(JSON.stringify(pack));
    },
  });
  try {
    const request = new AbortController();
    const first = reader.read(url, tuple, request.signal);
    const sibling = reader.read(url, tuple, new AbortController().signal);
    request.abort('request retired');
    const cancelled = await first;
    finish();
    const loaded = await sibling;
    return {
      cancelled: !cancelled.ok && cancelled.error.code,
      loaded: loaded.ok,
      calls,
    };
  } finally {
    finish();
    reader.dispose();
  }
}
