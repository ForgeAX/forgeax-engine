import { fileURLToPath } from 'node:url';
import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { compileShader } from '../compile';
import {
  engineMaterialArtifactReceipt,
  engineMaterialParamSchema,
  engineShaderDefines,
  engineShaderSourceImports,
  prepareEngineShaderSource,
} from '../engine-program';
import { collectMaterialSources } from '../material/pack-cooker';

const root = fileURLToPath(new URL('../../../shader/src', import.meta.url));
const files = (await collectMaterialSources([root], [root])).engine;
const imports = Object.fromEntries(files.map((file) => [file.moduleId, file.source]));

/** Calls in validated emitted WGSL; no comments, macros or indirect function calls remain. */
function reachability(source: string, entry: string) {
  const functions = new Map<string, string>();
  for (const match of source.matchAll(/\bfn\s+(\w+)\s*\([\s\S]*?\{/g)) {
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    let depth = 1;
    while (depth > 0 && index < source.length) {
      if (source[index] === '{') depth++;
      if (source[index] === '}') depth--;
      index++;
    }
    expect(depth).toBe(0);
    functions.set(match[1] ?? '', source.slice(start, index - 1));
  }
  const pending = [entry];
  const seen = new Set<string>();
  const kills: string[] = [];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const body = functions.get(name);
    expect(body, `missing function ${name}`).toBeDefined();
    if (body === undefined) continue;
    if (/\bdiscard\b/.test(body)) kills.push(name);
    for (const call of body.matchAll(/\b(\w+)\s*\(/g)) {
      const callee = call[1];
      if (callee !== undefined && functions.has(callee)) pending.push(callee);
    }
  }
  return { functions: [...seen], discards: kills };
}

async function compile(
  kind: 'unlit' | 'skin',
  { mask = false, clipping = false, scene = false, localClipping = false } = {},
) {
  const moduleId = kind === 'unlit' ? 'forgeax_material::unlit' : 'forgeax_material::pbr-skin';
  const source = files.find((file) => file.moduleId === moduleId);
  if (source === undefined) throw Error(`missing ${moduleId}`);
  const identifier = kind === 'unlit' ? 'forgeax::default-unlit' : 'forgeax::pbr-skin';
  const schema: readonly ParamSchemaEntry[] = [
    ...engineMaterialParamSchema(identifier),
    ...(localClipping
      ? ['clippingControl', ...'ABCDEF'.split('').map((letter) => `clippingPlane${letter}`)].map(
          (name) => ({ name, type: 'vec4' as const, default: [0, 0, 0, 0] }),
        )
      : []),
  ];
  const defines = engineShaderDefines(
    identifier,
    { MATERIAL_CLIPPING_AVAILABLE: localClipping },
    {
      STORAGE_BUFFER_AVAILABLE: true,
      GPU_DRIVEN_SCENE_INDEX_AVAILABLE: scene,
      CLUSTER_FORWARD_AVAILABLE: false,
      PROBE_BLEND_AVAILABLE: false,
      ALPHA_MASK: mask,
      CLIPPING_PLANES: clipping,
      LOD_DITHER: false,
      SKINNING_DISABLED: kind === 'unlit',
    },
    false,
    schema,
  );
  const file = {
    id: source.path,
    source: source.source,
    reservedIdentifier: identifier,
    paramSchema: schema,
  };
  const prepared = prepareEngineShaderSource(
    file,
    engineShaderSourceImports(file, imports),
    imports,
    defines,
  ).unwrap();
  const result = await compileShader(prepared.source, {
    imports: prepared.imports,
    defines,
    renderEntries: { vertex: 'vs_main', fragment: kind === 'unlit' ? 'fs_main' : 'fs_opaque' },
  });
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  const compiled = result.unwrap();
  for (const entry of compiled.reflection.entryPoints ?? []) {
    expect(entry.effects, `native effects missing for ${entry.name}`).toBeDefined();
    expect(entry.effects?.mayDiscard, `native/diagnostic discard mismatch for ${entry.name}`).toBe(
      reachability(compiled.wgsl, entry.name).discards.length > 0,
    );
  }
  expect(compiled.manifestEntry.entryPoints).toEqual(compiled.reflection.entryPoints);
  if (kind === 'unlit' && !localClipping) {
    // Direct and scene-index entries need the same canonical position proof.
    // The renderer must not infer
    // coverage from a shader name when reusing the primary depth attachment.
    expect(engineMaterialArtifactReceipt(file, compiled, defines).unwrap()?.positionBounds).toBe(
      'standard-input',
    );
  }
  return compiled.wgsl;
}

describe('Unlit and skinned selected-entry coverage', () => {
  it.each([
    'unlit',
    'skin',
  ] as const)('%s opaque entries have no reachable discard', async (kind) => {
    for (const scene of [false, true]) {
      const source = await compile(kind, { scene });
      expect(reachability(source, kind === 'unlit' ? 'fs_main' : 'fs_opaque').discards).toEqual([]);
    }
  });

  it.each(['unlit', 'skin'] as const)('%s retains real view clipping', async (kind) => {
    const source = await compile(kind, { clipping: true });
    const entry = kind === 'unlit' ? 'fs_main' : 'fs_opaque';
    const graph = reachability(source, entry);
    if (kind === 'skin') {
      expect(graph.discards).toEqual([entry]);
      expect(graph.functions).toContainEqual(expect.stringContaining('viewClippingRejected'));
    } else expect(graph.discards).toContainEqual(expect.stringContaining('applyLocalClipping'));
    expect(graph.functions).toContainEqual(expect.stringContaining('clippedByPlanes'));
  });

  it.each([
    'unlit',
    'skin',
  ] as const)('%s retains material planes with camera clipping disabled', async (kind) => {
    for (const scene of [false, true]) {
      const source = await compile(kind, { localClipping: true, scene });
      const entries =
        kind === 'unlit'
          ? ['fs_main', 'fs_ao_input', 'fs_temporal', 'fs_shadow']
          : ['fs_opaque', 'fs_ao_input', 'fs_temporal'];
      for (const entry of entries) {
        const graph = reachability(source, entry);
        expect(graph.discards).toContainEqual(expect.stringContaining('applyLocalClipping'));
        expect(graph.functions).not.toContainEqual(expect.stringContaining('applyViewClipping'));
      }
    }
  });

  it('retains Unlit cutoff/hash in color, surface-data, temporal and shadow entries', async () => {
    const source = await compile('unlit', { mask: true, clipping: true });
    for (const entry of ['fs_main', 'fs_ao_input', 'fs_temporal', 'fs_shadow']) {
      const graph = reachability(source, entry);
      expect(graph.discards).toContain(entry);
      expect(graph.discards).not.toContainEqual(expect.stringContaining('unlitCoverageRejected'));
      expect(graph.functions).toContainEqual(expect.stringContaining('alphaHashThreshold'));
    }
  });

  it('retains exact Unlit temporal coverage in the opaque publication lane', async () => {
    const source = await compile('unlit');
    expect(reachability(source, 'fs_main').discards).toEqual([]);
    expect(reachability(source, 'fs_temporal').discards).toContain('fs_temporal');
  });
});
