import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { runVertexColorProducerEntry, vertexColorProducerIsScheduled } from '../vertex-color-producer-entry';

const VERTEX_COLOR_BATCH_TIMEOUT_MS = 120_000;

it.skipIf(!vertexColorProducerIsScheduled())('runs the independent Three.js r184 Dawn vertex-color producer', () => {
  globalThis.__forgeaxVertexColorPublish = (path, output) => {
    writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
  };
  return runVertexColorProducerEntry('three', 'dawn');
}, VERTEX_COLOR_BATCH_TIMEOUT_MS);
