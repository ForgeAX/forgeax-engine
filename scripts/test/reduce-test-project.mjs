import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import quality from './render-quality.json' with { type: 'json' };

/** Remove the optional default library from a self-contained fixture manifest. */
export function withoutEngineContentLibrary(manifest) {
  const libraries = manifest.assetLibraries;
  if (!libraries?.includes('@forgeax/engine/content')) return manifest;
  return {
    ...manifest,
    assetLibraries: libraries.filter((library) => library !== '@forgeax/engine/content'),
  };
}

// Call only on a disposable project copy. Keep identities, entities, materials,
// emitters and topology; these probes observe behavior, not tessellation quality.
// Quality/capacity owners can override the relevant values at the call site.
export async function reduceTestProject(root, { omitEngineContent = false, ...overrides } = {}) {
  if (omitEngineContent) {
    const path = resolve(root, 'forge.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const reduced = withoutEngineContentLibrary(manifest);
    if (reduced !== manifest) await writeFile(path, `${JSON.stringify(reduced, null, 2)}\n`);
  }
  const q = { ...quality, ...overrides };
  const componentLimits = {
    DirectionalLight: { mapSize: q.shadowMapSize, cascadeCount: q.cascadeCount },
    SpotLight: { mapSize: q.shadowMapSize },
    ReflectionProbe: { resolution: q.reflectionResolution },
  };
  const assets = resolve(root, 'assets');
  for (const entry of await readdir(assets, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith('.pack.ts') && !name.endsWith('.pack.json')) continue;
    const path = resolve(entry.parentPath, name);
    const original = await readFile(path, 'utf8');
    // These component PODs contain scalar/array fields. Use the same projection
    // for JSON and TypeScript scene literals, including omitted engine defaults.
    let source = original.replace(
      /("?(\w+)"?\s*:\s*\{)([^{}]*)(\})/g,
      (all, open, type, body, close) => {
        if (!Object.hasOwn(componentLimits, type)) return all;
        for (const [field, limit] of Object.entries(componentLimits[type])) {
          const property = new RegExp(`("?${field}"?\\s*:\\s*)(\\d+)`);
          if (property.test(body)) {
            body = body.replace(
              property,
              (_, prefix, value) => `${prefix}${Math.min(+value, limit)}`,
            );
          } else if (!new RegExp(`"?${field}"?\\s*:`).test(body)) {
            const key = open.startsWith('"') ? JSON.stringify(field) : field;
            body = `${key}: ${limit}${body.trim() ? ',' : ''}${body}`;
          }
        }
        return open + body + close;
      },
    );
    if (name.endsWith('.pack.ts')) {
      // Keep the authored job and its complete output roster. Only lower the
      // declared bake resolution within its supported range on this test copy.
      source = source.replace(
        /(name:\s*(['"])resolution\2,\s*type:\s*(['"])u32\3,\s*default:\s*)([A-Za-z_$][\w$]*|\d+)(,\s*minimum:\s*)(\d+)/g,
        (_, prefix, _nameQuote, _typeQuote, value, suffix, minimum) =>
          `${prefix}Math.min(${value}, ${Math.max(q.proceduralTextureResolution, +minimum)})${suffix}${minimum}`,
      );
      const g = q.geometry;
      source = source
        .replace(
          /createSphereGeometry\(([^,]+), (\d+), (\d+)\)/g,
          (_, radius, width, height) =>
            `createSphereGeometry(${radius}, ${Math.min(+width, g.sphereWidth)}, ${Math.min(+height, g.sphereHeight)})`,
        )
        .replace(
          /createCylinderGeometry\(([^,]+), ([^,]+), ([^,]+), (\d+), (\d+)\)/g,
          (_, top, bottom, height, radial, vertical) =>
            `createCylinderGeometry(${top}, ${bottom}, ${height}, ${Math.min(+radial, g.cylinderSegments)}, ${vertical})`,
        )
        .replace(
          /createTorusGeometry\(([^,]+), ([^,]+), (\d+), (\d+)\)/g,
          (_, radius, tube, radial, tubular) =>
            `createTorusGeometry(${radius}, ${tube}, ${Math.min(+radial, g.torusRadial)}, ${Math.min(+tubular, g.torusTubular)})`,
        )
        .replace(
          /(uSegments: )(\d+)/g,
          (_, prefix, count) => `${prefix}${Math.min(+count, g.surfaceU)}`,
        )
        .replace(
          /(vSegments: )(\d+)/g,
          (_, prefix, count) => `${prefix}${Math.min(+count, g.surfaceV)}`,
        );
    } else {
      const pack = JSON.parse(source);
      let changed = false;
      for (const asset of Object.values(pack.assets ?? {})) {
        for (const emitter of asset.payload?.emitters ?? []) {
          emitter.capacity = Math.min(emitter.capacity, q.particles.capacity);
          if (emitter.schedule !== undefined) {
            emitter.schedule.rate = Math.min(emitter.schedule.rate ?? 0, q.particles.rate);
            for (const burst of emitter.schedule.bursts ?? []) {
              burst.count = Math.min(burst.count, q.particles.burst, emitter.capacity);
            }
          }
          changed = true;
        }
      }
      if (changed) source = `${JSON.stringify(pack, null, 2)}\n`;
    }
    if (source !== original) await writeFile(path, source);
  }
}
