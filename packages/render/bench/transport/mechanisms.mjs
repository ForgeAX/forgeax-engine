// Isolated Worker transport mechanisms for one publication-sized payload.
// Compares the cost of moving the SAME bytes four ways, without any Renderer:
//   clone     structured-cloned object graph (rows as plain objects) + no transfer
//   columns   object envelope + five separately transferred typed columns (pre-§9 protocol)
//   slot      one transferred ArrayBuffer slot carrying header + columns (§9 protocol)
//   shared    one SharedArrayBuffer slot, message carries only {slot, bytes}
// Each message is a ping-pong: the receiver decodes (sums every float) and
// returns the slot. Reports per-message sender postMessage CPU, receiver thread
// CPU (deserialize + decode + reply), round trip, and V8 heap bytes allocated
// per message on each thread (window totals; the counter is read only at the
// window boundaries because each read flushes a linear allocation buffer).
import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

const allocated = () => getHeapStatistics().total_allocated_bytes;
const cpu = () => {
  const usage = process.threadCpuUsage();
  return (usage.user + usage.system) / 1000;
};

function decode(message) {
  let sum = 0;
  if (message.kind === 'clone') {
    for (const row of message.rows) for (const value of row.world) sum += value;
  } else if (message.kind === 'columns') {
    const transforms = message.publication.transforms;
    for (let i = 0; i < transforms.length; i++) sum += transforms[i];
  } else {
    const bytes = message.kind === 'shared' ? slots[message.slot] : message.buffer;
    const header = new Uint32Array(bytes, 0, 4);
    const floats = new Float32Array(bytes, 16, header[1] * 16);
    for (let i = 0; i < floats.length; i++) sum += floats[i];
  }
  return sum;
}

let slots = [];
if (!isMainThread) {
  let receiverCpu = 0;
  let receiverAllocated = 0;
  let markCpu = cpu(), markAllocated = allocated();
  parentPort.on('message', (message) => {
    if (message.kind === 'slots') {
      slots = message.slots;
      return;
    }
    if (message.kind === 'stats') {
      parentPort.postMessage({ receiverCpu, receiverAllocated, threadCpu: cpu() - markCpu, threadAllocated: allocated() - markAllocated });
      receiverCpu = 0;
      receiverAllocated = 0;
      markCpu = cpu();
      markAllocated = allocated();
      return;
    }
    const sum = decode(message);
    if (!Number.isFinite(sum)) throw new Error('decode');
    if (message.kind === 'columns') {
      const p = message.publication;
      const buffers = [p.upserts.buffer, p.removed.buffer, p.transformEntities.buffer, p.transforms.buffer, p.retiredJoints.buffer];
      parentPort.postMessage({ kind: 'done', buffers }, buffers);
    } else if (message.kind === 'slot') parentPort.postMessage({ kind: 'done', buffer: message.buffer }, [message.buffer]);
    else parentPort.postMessage({ kind: 'done', slot: message.slot });
  });
} else {
  const changes = Number(process.argv[2] ?? 8);
  const messages = Number(process.argv[3] ?? 2000);
  const metadataBytes = Number(process.argv[4] ?? 0);
  // A metadata-shaped object graph (cameras/lights rows) of roughly the requested serialized size.
  const metadata = Array.from({ length: Math.ceil(metadataBytes / 160) }, (_, i) => ({ entity: i, kind: 'point', color: [1, 0.9, 0.8], intensity: 2, range: 10, position: new Float32Array(3) }));
  const worker = new Worker(new URL(import.meta.url), { workerData: {} });
  const reply = () => new Promise((resolve) => worker.once('message', resolve));
  const results = {};
  for (const kind of ['clone', 'columns', 'slot', 'shared']) {
    const slotBytes = 16 + changes * 64 + changes * 4;
    const shared = [new SharedArrayBuffer(Math.max(64, slotBytes)), new SharedArrayBuffer(Math.max(64, slotBytes))];
    if (kind === 'shared') worker.postMessage({ kind: 'slots', slots: shared });
    let pool = [new ArrayBuffer(Math.max(64, slotBytes)), new ArrayBuffer(Math.max(64, slotBytes))];
    let columnPool = [0, 1].map(() => [4, 4, changes * 4, changes * 64, 4].map((n) => new ArrayBuffer(Math.max(16, n))));
    let senderCpu = 0, senderAllocated = 0, roundTrip = 0;
    for (let i = 0; i < messages + 200; i++) {
      if (i === 200) {
        senderCpu = 0; roundTrip = 0; senderAllocated = allocated();
        worker.postMessage({ kind: 'stats' });
        await reply();
      }
      const start = performance.now(), c = cpu();
      if (kind === 'clone') {
        const rows = Array.from({ length: changes }, (_, entity) => ({ entity, world: Array.from({ length: 16 }, (_, k) => k + i) }));
        worker.postMessage({ kind, rows, metadata });
      } else if (kind === 'columns') {
        const [u, r, e, t, j] = columnPool.pop();
        const transforms = new Float32Array(t, 0, changes * 16);
        for (let k = 0; k < transforms.length; k++) transforms[k] = k + i;
        const publication = { upserts: new Uint32Array(u, 0, 0), removed: new Uint32Array(r, 0, 0), transformEntities: new Uint32Array(e, 0, changes), transforms, retiredJoints: new Uint32Array(j, 0, 0), metadata };
        worker.postMessage({ kind, publication }, [u, r, e, t, j]);
      } else {
        const buffer = kind === 'shared' ? shared[i % 2] : pool.pop();
        const header = new Uint32Array(buffer, 0, 4);
        header[1] = changes;
        const floats = new Float32Array(buffer, 16, changes * 16);
        for (let k = 0; k < floats.length; k++) floats[k] = k + i;
        if (kind === 'shared') worker.postMessage(metadataBytes > 0 ? { kind, slot: i % 2, metadata } : { kind, slot: i % 2 });
        else worker.postMessage(metadataBytes > 0 ? { kind, buffer, metadata } : { kind, buffer }, [buffer]);
      }
      senderCpu += cpu() - c;
      const done = await reply();
      roundTrip += performance.now() - start;
      if (kind === 'columns') columnPool.push(done.buffers);
      if (kind === 'slot') pool.push(done.buffer);
    }
    senderAllocated = allocated() - senderAllocated;
    worker.postMessage({ kind: 'stats' });
    const receiver = await reply();
    results[kind] = {
      senderUs: +(senderCpu / messages * 1000).toFixed(2),
      roundTripUs: +(roundTrip / messages * 1000).toFixed(1),
      senderAllocBytes: Math.round(senderAllocated / messages),
      receiverThreadUs: +(receiver.threadCpu / messages * 1000).toFixed(2),
      receiverThreadAllocBytes: Math.round(receiver.threadAllocated / messages),
    };
  }
  await worker.terminate();
  console.log(JSON.stringify({ changes, messages, metadataBytes, results }));
}
