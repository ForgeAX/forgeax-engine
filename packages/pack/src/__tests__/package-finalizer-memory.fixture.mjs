import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';

const finalizerUrl = new URL('../package-finalizer.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      context.parentURL === finalizerUrl && specifier === './material-program-wire.js'
        ? new URL('../material-program-wire.ts', import.meta.url).href
        : specifier,
      context,
    );
  },
});
const { finalizePackageTransportSource } = await import(finalizerUrl);

const repeatedText = process.argv[2] === 'repeated-text';
const values = repeatedText
  ? Array(96).fill('x'.repeat(1024 * 1024))
  : Array(16 * 1024 * 1024).fill(1);
const input = {
  assets: [
    {
      guid: '019f0000-0000-7000-8000-000000000070',
      kind: 'material',
      payload: { z: [{ z: 1, a: 2 }], bytes: values, a: 'complete numeric payload' },
      refs: [],
      artifacts: {},
    },
  ],
};
let publication;
let sinkMemory;
const result = await finalizePackageTransportSource(input, {
  base: '/',
  packagePath: 'memory.pack.json',
  artifactPath: (guid, key) => `${guid}/${key}.bin`,
  sink: (_path, bytes) => {
    publication = bytes;
    if (repeatedText) sinkMemory = process.memoryUsage();
  },
});
process.stdout.write(
  `${JSON.stringify({
    sourceRevision: result.sourceRevision,
    digest: result.digest,
    semanticDigest: createHash('sha256').update(publication).digest('hex'),
    semanticBytes: publication.byteLength,
    payloadValues: result.pack.assets[0].payload.bytes.length,
    retainedPayload: result.pack.assets[0].payload.bytes === values,
    ...(repeatedText
      ? {
          heapLimit: (await import('node:v8')).getHeapStatistics().heap_size_limit,
          sinkMemory,
          maxRssKiB: process.resourceUsage().maxRSS,
        }
      : {}),
  })}\n`,
);
