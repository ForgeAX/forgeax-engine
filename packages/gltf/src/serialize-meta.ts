// @forgeax/engine-gltf/src/serialize-meta.ts — byte-stable meta JSON
// serialization (sorted-keys, LF ending) for the
// `<source>.meta.json` sidecar. Extracted from cli-gltf.ts so it can
// be re-exported from the package barrel as a reusable library
// function (plan-strategy D-3; feat-20260705-editor-core-engine-convergence-store-ts-decompose AC-04).
//
// Anchors: plan-strategy D-3, requirements AC-04, research F-7.

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

export function serializeMetaJson(meta: unknown): string {
  return `${JSON.stringify(sortKeysDeep(meta), null, 2)}\n`;
}
