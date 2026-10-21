import { open, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';


// Called only after the measured window and sampler have ended. Keep raw
// evidence, but never build a single V8 string containing the entire trace.
async function writeRows(path, rows) {
  const file = await open(path, 'w');
  let batch = '';
  try {
    for (const row of rows) {
      const line = JSON.stringify(row) + '\n';
      if (batch.length + line.length > 65536) {
        await file.writeFile(batch);
        batch = '';
      }
      batch += line;
    }
    if (batch) await file.writeFile(batch);
  } finally {
    await file.close();
  }
}

function* allocationNodes(head) {
  const pending = [head];
  while (pending.length) {
    const { children, ...node } = pending.pop();
    yield { ...node, children: children.map(child => child.id) };
    for (const child of children) pending.push(child);
  }
}

export async function writeHeapEvidence(path, heap) {
  const tracePath = path + '.trace.ndjson';
  await writeRows(tracePath, heap.trace);
  const realms = [];
  for (const [index, realm] of heap.realms.entries()) {
    const { allocation, ...retained } = realm;
    if (!allocation) {
      realms.push(retained);
      continue;
    }
    const nodesPath = path + `.realm${index}.nodes.ndjson`;
    const samplesPath = path + `.realm${index}.samples.ndjson`;
    await writeRows(nodesPath, allocationNodes(allocation.head));
    let allocationBytes = 0;
    function* samples() {
      for (const sample of allocation.samples) {
        allocationBytes += sample.size;
        yield sample;
      }
    }
    await writeRows(samplesPath, samples());
    const frames = heap.completedFrameBounds;
    realms.push({ ...retained,
      allocationBytes,
      allocationBytesPerCompletedFrameBounds: frames?.minimum > 0 ? {
        minimum: allocationBytes / frames.maximum, maximum: allocationBytes / frames.minimum,
      } : null,
      allocation: { nodes: basename(nodesPath), samples: basename(samplesPath), root: allocation.head.id },
    });
  }
  const { trace, realms: originalRealms, ...metadata } = heap;
  const compact = { ...metadata, format: 3, realms, trace: basename(tracePath) };
  await writeFile(path, JSON.stringify(compact));
  return compact;
}
