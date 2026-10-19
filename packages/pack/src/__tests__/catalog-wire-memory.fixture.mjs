import { decodeCatalogWire, encodeCatalogWire } from '../catalog-wire.ts';
import { createRuntimePackPublication } from '../runtime-publication.ts';

const { publication } = createRuntimePackPublication({
  pack: {
    assets: Array.from({ length: 512 }, (_, index) => ({
      guid: `output-${index}`,
      kind: 'mesh',
      payload: { marker: index },
      refs: [],
    })),
  },
  scopeId: 'wire-memory',
  sourcePath: 'large.pack.ts',
  sourceRevision: 'source-revision',
  packageUrl: '/large.pack.json',
});
// Distinct equal envelopes occur after cache restoration. Share their immutable
// children here to isolate encoder retention from the input's own storage cost.
const entries = Array.from({ length: 4096 }, (_, index) => ({
  guid: `row-${index}`,
  kind: 'mesh',
  packageUrl: '/large.pack.json',
  publication: { ...publication },
}));
const wire = encodeCatalogWire(entries);
const rows = decodeCatalogWire(JSON.parse(JSON.stringify(wire))).unwrap();
process.stdout.write(
  JSON.stringify({
    rows: rows.length,
    publications: wire.publications.length,
    outputs: rows[0].publication.outputs.length,
    shared: rows.every((row) => row.publication === rows[0].publication),
  }),
);
