import { it } from 'vitest';
import { runVertexColorProducerEntry, vertexColorProducerIsScheduled } from '../vertex-color-producer-entry';

const VERTEX_COLOR_BATCH_TIMEOUT_MS = 120_000;

it.skipIf(!vertexColorProducerIsScheduled())('runs the independent Three.js r184 Browser WebGPU vertex-color producer', () => {
  globalThis.__forgeaxVertexColorPublish = async (path, output) => {
    const urls = JSON.parse(import.meta.env.VITE_FORGEAX_VERTEX_COLOR_OUTPUT_URLS ?? '{}') as Record<string, string>;
    const falsifierUrls = JSON.parse(import.meta.env.VITE_FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUT_URLS ?? '{}') as Record<string, string>;
    const url = path === '__falsifier__' || path.endsWith('.falsifier.capture.json')
      ? falsifierUrls[path] ?? import.meta.env.VITE_FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUT_URL
      : urls[path] ?? import.meta.env.VITE_FORGEAX_VERTEX_COLOR_OUTPUT_URL;
    if (url === undefined) throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'browser output receiver URL is unavailable' }));
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(output) });
    if (!response.ok) throw new Error(`browser output receiver rejected capture: ${response.status}`);
  };
  return runVertexColorProducerEntry('three', 'browser-webgpu');
}, VERTEX_COLOR_BATCH_TIMEOUT_MS);
