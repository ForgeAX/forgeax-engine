import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { loadEngineShaderEntries } from '../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';

/** Static call inventory of Naga-validated WGSL. Entry resource facts below are
 * authoritative; this inventory additionally bounds the compilation work. */
function calls(source: string, entry: string): string[] {
  const declarations = [...source.matchAll(/\bfn\s+(\w+)\s*\(/g)];
  const bodies = new Map<string, string>();
  for (const [i, match] of declarations.entries())
    bodies.set(
      match[1] ?? '',
      source.slice(match.index, declarations[i + 1]?.index ?? source.length),
    );
  const result = new Set<string>(),
    pending = [entry];
  while (pending.length) {
    const name = pending.pop();
    if (!name || result.has(name)) continue;
    const body = bodies.get(name);
    if (!body) throw new Error(`Missing compiled function ${name}`);
    result.add(name);
    for (const match of body.matchAll(/\b(\w+)\s*\(/g))
      if (match[1] && bodies.has(match[1]) && !result.has(match[1])) pending.push(match[1]);
  }
  return [...result].sort();
}

it('cooks live and baked direct-copy entries without Field or canonical geometry dependencies', {
  timeout: 60_000,
}, async () => {
  const builtin = await loadEngineShaderEntries();
  for (const name of ['rayIrradianceField', 'rayBakedField'] as const) {
    const program = builtin[name];
    const compiled = (
      await compileShader(program.source, {
        id: `field-direct-copy-${name}`,
        imports: builtin.imports,
        ...(program.defines ? { defines: program.defines } : {}),
      })
    ).unwrap();
    const entry = compiled.manifestEntry.entryPoints?.find((e) => e.name === 'copyDirectCards');
    expect(entry).toBeDefined();
    expect(entry?.bindings.map((b) => [b.group, b.binding])).toEqual([
      [0, 0],
      [0, 2],
      [0, 4],
      [0, 5],
    ]);
    expect(entry?.bindings.find((b) => b.binding === 2)?.fields).toEqual(['valid']);
    const reachable = calls(compiled.wgsl, 'copyDirectCards');
    expect(
      reachable.filter((n) =>
        /sampleIrradianceField|fieldSegment|sdfSurface|sdfInterval|sdfScene/.test(n),
      ),
    ).toEqual([]);
    const reflectionEntries = (compiled.manifestEntry.entryPoints ?? [])
      .map((item) => item.name)
      .filter((entryName) => entryName.endsWith('FieldReflections'))
      .sort();
    expect(reflectionEntries).toEqual(
      name === 'rayIrradianceField'
        ? ['accumulateFieldReflections', 'filterFieldReflections', 'generateFieldReflections']
        : [],
    );
    const feedback = compiled.manifestEntry.entryPoints?.find((e) => e.name === 'radiateCards');
    expect(feedback?.bindings.some((b) => b.group === 1)).toBe(true);
    const out = process.env.FORGEAX_FIELD_DEMAND_COMPOSITION;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(`${out}/${name}.wgsl`, compiled.wgsl);
      writeFileSync(`${out}/${name}.json`, JSON.stringify({ entry, feedback, reachable }, null, 2));
    }
  }
});

it('defines the exact feedback-off RGBA result independently of direct-light alpha', () => {
  // Fixed expected vectors will also be the GPU oracle. They deliberately
  // include valid surfaces with alpha0 and invalid surfaces with nonzero RGB.
  const direct = new Float32Array([1, 2, 3, 0, 4, 5, 6, 1, -0, 0.25, 0.5, -7, 0.75, 0.5, 0.25, 99]);
  const valid = [1, 0, 1, 0];
  const expected = new Float32Array([1, 2, 3, 1, 4, 5, 6, 0, -0, 0.25, 0.5, 1, 0.75, 0.5, 0.25, 0]);
  const legacyOff = new Float32Array(direct.length);
  for (let row = 0; row < valid.length; row++) {
    legacyOff.set(direct.subarray(row * 4, row * 4 + 3), row * 4);
    legacyOff[row * 4 + 3] = valid[row] ?? 0;
  }
  expect(new Uint8Array(legacyOff.buffer)).toEqual(new Uint8Array(expected.buffer));
  expect(new Uint8Array(direct.buffer)).not.toEqual(new Uint8Array(expected.buffer));
  const wrongInvalid = legacyOff.slice();
  wrongInvalid.fill(0, 4, 8);
  expect(new Uint8Array(wrongInvalid.buffer)).not.toEqual(new Uint8Array(expected.buffer));
});
