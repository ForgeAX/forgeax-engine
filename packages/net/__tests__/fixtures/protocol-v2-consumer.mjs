import {
  decodeReplicationPacket,
  encodeReplicationPacket,
  REPLICATION_PROTOCOL_PREFIX,
  REPLICATION_PROTOCOL_VERSION,
} from '@forgeax/engine-net';

const limits = {
  maxMessageBytes: 64 * 1024,
  maxEntities: 1024,
  maxComponentOperations: 4096,
  maxStringBytes: 4096,
  maxBufferBytes: 16 * 1024,
  maxArrayElements: 1024,
};
const sessionId = 17;
const packets = [
  { version: 2, kind: 'session-open', sessionId, epoch: 0, sequence: 0 },
  { version: 2, kind: 'session-resume', sessionId, epoch: 1, sequence: 0 },
  {
    version: 2,
    kind: 'baseline',
    sessionId,
    epoch: 1,
    sequence: 1,
    tick: 1,
    fingerprint: 'fixture-profile',
    entities: [{ id: 1, kind: 'upsert', components: [] }],
  },
  {
    version: 2,
    kind: 'delta',
    sessionId,
    epoch: 1,
    sequence: 2,
    tick: 2,
    fingerprint: 'fixture-profile',
    entities: [{ id: 1, kind: 'upsert', components: [] }],
  },
  { version: 2, kind: 'ack', sessionId, epoch: 1, acknowledgedSequence: 2 },
  {
    version: 2,
    kind: 'rejection',
    sessionId,
    epoch: 1,
    sequence: 2,
    rejectedKind: 'delta',
    reason: 'gap',
  },
];

for (const packet of packets) {
  const encoded = encodeReplicationPacket(packet, limits);
  if (!encoded.ok) throw new Error(`encode failed for ${packet.kind}: ${encoded.error.code}`);
  const text = new TextDecoder().decode(encoded.value);
  if (!text.startsWith(`${REPLICATION_PROTOCOL_PREFIX}\n`))
    throw new Error(`missing ${REPLICATION_PROTOCOL_PREFIX} prefix`);
  const decoded = decodeReplicationPacket(encoded.value, limits);
  if (!decoded.ok) throw new Error(`decode failed for ${packet.kind}: ${decoded.error.code}`);
  if (JSON.stringify(stable(decoded.value)) !== JSON.stringify(stable(packet)))
    throw new Error(`round-trip changed ${packet.kind}`);
}

const unsupported = decodeReplicationPacket(
  new TextEncoder().encode(`${REPLICATION_PROTOCOL_PREFIX}\n${JSON.stringify({ version: 1 })}`),
  limits,
);
if (unsupported.ok || unsupported.error.code !== 'protocol-unsupported-version')
  throw new Error('protocol-v1 must fail before dispatch');

console.log(`protocol-v2 consumer passed ${packets.length} public packet shapes`);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
