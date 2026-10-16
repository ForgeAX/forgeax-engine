import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { type AssetError, ok, type Result } from '@forgeax/engine-types';
import { BufferAttribute, BufferGeometry } from 'three';
import { formatFailure } from './errors.js';
import { geometryToMesh, type ImportedMesh } from './geometry.js';

const require = createRequire(import.meta.url);

/** DOM ownership is isolated from the Host; every Worker exits after one bounded parse. */
export async function svgWorker(
  text: string,
  curveSegments: number,
): Promise<Result<readonly ImportedMesh[], AssetError>> {
  if (
    text.length > 16_000_000 ||
    /<!DOCTYPE|<!ENTITY|<(?:script|image|foreignObject|linearGradient|radialGradient|filter|mask|clipPath)\b|url\(/i.test(
      text,
    )
  )
    return formatFailure(
      'SVG',
      'external content, gradients, filters, masks and clipping are unsupported',
    );
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { DOMParser } = await import(workerData.dom);
      globalThis.DOMParser = DOMParser;
      const { SVGLoader } = await import(workerData.loader);
      const { ShapeGeometry, Float32BufferAttribute, Color } = await import(workerData.three);
      const warnings = [];
      console.warn = (...args) => warnings.push(args.join(' '));
      const parsed = new SVGLoader().parse(workerData.text);
      if (parsed.xml.nodeName !== 'svg') throw new Error('expected an SVG root');
      const output = [];
      for (const [pathIndex, path] of parsed.paths.entries()) {
        const style = path.userData.style;
        const geometries = [];
        if (style.fill !== 'none' && style.fillOpacity > 0) {
          for (const shape of SVGLoader.createShapes(path)) geometries.push({ geometry: new ShapeGeometry(shape, workerData.segments), color: path.color, opacity: style.fillOpacity * (style.opacity ?? 1) });
        }
        if (style.stroke !== undefined && style.stroke !== 'none' && style.strokeOpacity > 0 && style.strokeWidth > 0) {
          for (const subpath of path.subPaths) {
            const geometry = SVGLoader.pointsToStroke(subpath.getPoints(workerData.segments), style, workerData.segments);
            if (geometry) geometries.push({ geometry, color: new Color(style.stroke), opacity: style.strokeOpacity * (style.opacity ?? 1) });
          }
        }
        for (const [part, { geometry, color, opacity }] of geometries.entries()) {
          const position = geometry.getAttribute('position');
          if (position.count > 1000000) throw new Error('SVG exceeds one million vertices');
          const colors = new Float32Array(position.count * 4);
          for (let i = 0; i < position.count; i++) colors.set([color.r, color.g, color.b, opacity], i * 4);
          geometry.setAttribute('color', new Float32BufferAttribute(colors, 4));
          output.push({ name: (path.userData.node.id || 'Path_' + pathIndex) + '_' + part, attributes: Object.fromEntries(Object.entries(geometry.attributes).map(([key, value]) => [key, value.array])), indices: geometry.index?.array });
          geometry.dispose();
        }
      }
      if (warnings.length) throw new Error(warnings.join('; '));
      parentPort.postMessage({ output });
    })().catch(error => parentPort.postMessage({ error: error.message }));
  `;
  return new Promise((resolve) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: {
        text,
        segments: curveSegments,
        dom: pathToFileURL(require.resolve('linkedom')).href,
        loader: pathToFileURL(require.resolve('three/addons/loaders/SVGLoader.js')).href,
        three: pathToFileURL(require.resolve('three')).href,
      },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(formatFailure('SVG', 'parse exceeded thirty seconds'));
    }, 30_000);
    worker.once('error', (error) => {
      clearTimeout(timer);
      resolve(formatFailure('SVG', error.message));
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) resolve(formatFailure('SVG', `worker exited with ${code}`));
    });
    worker.once(
      'message',
      (result: {
        error?: string;
        output?: {
          name: string;
          attributes: Record<string, Float32Array>;
          indices?: Uint16Array | Uint32Array;
        }[];
      }) => {
        clearTimeout(timer);
        void worker.terminate();
        if (
          result.error !== undefined ||
          result.output === undefined ||
          result.output.length === 0
        ) {
          resolve(formatFailure('SVG', result.error ?? 'no visible paths'));
          return;
        }
        const meshes: ImportedMesh[] = [];
        for (const entry of result.output) {
          const geometry = new BufferGeometry();
          for (const [key, values] of Object.entries(entry.attributes))
            geometry.setAttribute(
              key,
              new BufferAttribute(values, key === 'uv' ? 2 : key === 'color' ? 4 : 3),
            );
          if (entry.indices !== undefined) geometry.setIndex(new BufferAttribute(entry.indices, 1));
          const mesh = geometryToMesh(geometry);
          geometry.dispose();
          if (!mesh.ok) {
            resolve(mesh);
            return;
          }
          meshes.push({ name: entry.name, mesh: mesh.value });
        }
        resolve(ok(meshes));
      },
    );
  });
}
