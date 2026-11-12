import { parentPort } from 'node:worker_threads';
import { fixtureDigests } from './determinism-fixtures.ts';

fixtureDigests().then(
  (digests) => parentPort?.postMessage({ ok: true, digests }),
  (error: unknown) => parentPort?.postMessage({ ok: false, error: String(error) }),
);
