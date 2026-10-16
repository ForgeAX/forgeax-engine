import { createHash } from 'node:crypto';
import { finalizePackageTransportSource } from '../package-finalizer.ts';

const values = Array(16 * 1024 * 1024).fill(1);
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
const result = await finalizePackageTransportSource(input, {
  base: '/',
  packagePath: 'memory.pack.json',
  artifactPath: (guid, key) => `${guid}/${key}.bin`,
  sink: (_path, bytes) => {
    publication = bytes;
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
  })}\n`,
);
