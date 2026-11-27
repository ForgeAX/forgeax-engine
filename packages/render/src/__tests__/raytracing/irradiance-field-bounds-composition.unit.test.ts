import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  SDF_SURFACE_BOUNDS_WGSL,
  SDF_SURFACE_TRACE_WGSL,
  SDF_SURFACE_TRACE_WITH_BOUNDS_WGSL,
} from '../../../../shader/src/sdf-surface-trace-wgsl';
import { compileShader } from '../../../../shader-compiler/src/index';
import { loadEngineShaderEntries } from '../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { irradianceFieldKernelWgsl } from '../../raytracing/irradiance-field';
import { screenProbeWorldWgsl } from '../../raytracing/screen-probe-kernels';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

it('retains the exact nearest module and real consumer strings at the same math version', () => {
  expect(sha(SDF_SURFACE_TRACE_WGSL)).toBe(
    'b16e1ae23467776679ba812051f13add917492f6045c0629ecd101033c18bd0f',
  );
  const snapshot = {
    trace: SDF_SURFACE_TRACE_WGSL,
    worldSW: worldTraversalWgsl('global-sdf'),
    worldHW: worldTraversalWgsl('ray-query'),
    fieldSW: irradianceFieldKernelWgsl('global-sdf'),
    fieldHW: irradianceFieldKernelWgsl('ray-query'),
    screenSW: screenProbeWorldWgsl('global-sdf'),
    screenHW: screenProbeWorldWgsl('ray-query'),
  };
  const file = process.env.FORGEAX_BOUNDS_NEAREST_BEFORE;
  if (file) {
    const before = JSON.parse(readFileSync(file, 'utf8')) as typeof snapshot;
    expect(snapshot).toEqual(before);
  }
  expect(snapshot.worldSW).toContain(SDF_SURFACE_TRACE_WGSL);
});

function rowKernel(mode: 'nearest' | 'bounds' | 'both'): string {
  const module =
    mode === 'nearest'
      ? SDF_SURFACE_TRACE_WGSL
      : mode === 'bounds'
        ? SDF_SURFACE_BOUNDS_WGSL
        : SDF_SURFACE_TRACE_WITH_BOUNDS_WGSL;
  const call =
    mode === 'nearest'
      ? 'sdfSurfaceTraceRow(0u,ray,&remaining).state'
      : 'sdfSurfaceBoundsRow(0u,ray,&remaining)';
  return `${module}
@group(0) @binding(0) var<storage,read> fields:array<u32>;
@group(0) @binding(1) var<storage,read> instances:array<u32>;
@group(0) @binding(2) var<storage,read> queries:array<vec4u>;
@group(0) @binding(3) var<storage,read_write> output:array<u32>;
fn sdfFieldWordCount()->u32{return arrayLength(&fields);}
fn sdfFieldWord(i:u32)->u32{if(i>=arrayLength(&fields)){return 0u;}return fields[i];}
fn sdfInstanceRowCount()->u32{return arrayLength(&instances)/36u;}
fn sdfInstanceWord(r:u32,w:u32)->u32{if(r>=sdfInstanceRowCount()||w>=36u){return 0u;}return instances[r*36u+w];}
@compute @workgroup_size(1) fn verifyBounds(){
 let ray=SdfSurfaceRay(queries[0].xyz,queries[1].xyz,queries[2].xyz,queries[3].xyz,queries[4].xy,queries[4].z);
 var remaining=queries[5].x;output[0]=${call};output[1]=remaining;
 ${mode === 'both' ? 'remaining=queries[5].x;output[2]=sdfSurfaceTraceRow(0u,ray,&remaining).state;' : ''}
}`;
}

/** Conservative source-call inventory over already Naga-validated output. This
 * is a compilation-cost scope check, not a replacement for shader validation. */
function reachableFunctions(source: string, entry: string): string[] {
  const declarations = [...source.matchAll(/\bfn\s+(\w+)\s*\(/g)];
  const bodies = new Map<string, string>();
  for (const [index, match] of declarations.entries()) {
    const end = declarations[index + 1]?.index ?? source.length;
    bodies.set(match[1] ?? '', source.slice(match.index, end));
  }
  const result = new Set<string>(),
    pending = [entry];
  while (pending.length) {
    const name = pending.pop();
    if (!name || result.has(name)) continue;
    const body = bodies.get(name);
    if (!body) throw Error(`Missing actual compiled entry/function ${name}`);
    result.add(name);
    for (const match of body.matchAll(/\b(\w+)\s*\(/g)) {
      const callee = match[1];
      if (callee && bodies.has(callee) && !result.has(callee)) pending.push(callee);
    }
  }
  return [...result].sort();
}

it('compiles one row-loop authority and keeps the bounds entry free of triangle and prefix work', async () => {
  for (const mode of ['nearest', 'bounds', 'both'] as const) {
    const compiled = (
      await compileShader(rowKernel(mode), { id: `field-bounds-${mode}` })
    ).unwrap();
    const reachable = reachableFunctions(compiled.wgsl, 'verifyBounds');
    if (mode === 'bounds') {
      expect(reachable.some((name) => name.startsWith('sdfSurfaceSlab'))).toBe(true);
      expect(reachable.some((name) => name.startsWith('sdfSurfaceLocalRay'))).toBe(true);
      for (const forbidden of [
        'sdfSurfaceLeafTriangle',
        'sdfSurfaceTriangle',
        'sdfIntervalVectorCross',
        'sdfSurfaceRootPrefix',
        'sdfSurfaceAccept',
        'sdfSurfaceTraceRow',
      ])
        expect(
          reachable.filter((name) => name.startsWith(forbidden)),
          forbidden,
        ).toEqual([]);
    }
    const out = process.env.FORGEAX_BOUNDS_COMPOSITION_OUTPUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(`${out}/${mode}.wgsl`, compiled.wgsl);
      writeFileSync(
        `${out}/${mode}-reachable.json`,
        JSON.stringify({ reachable, compiledSHA256: sha(compiled.wgsl) }, null, 2),
      );
    }
  }
});

it('compiles the actual software World, Field, Screen Probe and Builtin live/baked modules', async () => {
  const builtin = await loadEngineShaderEntries(),
    world = irradianceFieldKernelWgsl('global-sdf');
  const programs = [
    ...(['cardSurface', 'traceProbes', 'traceReflections'] as const).map((name) => ({
      name,
      source: world[name],
      defines: {},
    })),
    { name: 'screenProbeWorld', source: screenProbeWorldWgsl('global-sdf'), defines: {} },
    ...(['rayIrradianceField', 'rayBakedField', 'rayScreenProbe'] as const).map((name) => ({
      name,
      source: builtin[name].source,
      defines: builtin[name].defines,
    })),
  ];
  const results = [];
  for (const program of programs) {
    const compiled = (
      await compileShader(program.source, {
        id: `bounds-audit-${program.name}`,
        imports: builtin.imports,
        ...(program.defines ? { defines: program.defines } : {}),
      })
    ).unwrap();
    const entries = compiled.manifestEntry.entryPoints?.map((entry) => ({
      name: entry.name,
      reachable: reachableFunctions(compiled.wgsl, entry.name),
    }));
    if (program.name === 'rayIrradianceField' || program.name === 'rayScreenProbe')
      for (const entry of entries ?? [])
        for (const forbidden of [
          'sdfSurfaceLeafTriangle',
          'sdfSurfaceTriangle',
          'sdfIntervalVectorCross',
          'sdfSurfaceRootPrefix',
          'sdfSurfaceAccept',
          'sdfSurfaceTraceRow',
        ])
          expect(
            entry.reachable.filter((name) => name.includes(forbidden)),
            `${program.name}.${entry.name}:${forbidden}`,
          ).toEqual([]);
    const directory = process.env.FORGEAX_BOUNDS_COMPOSITION_OUTPUT;
    if (directory) writeFileSync(`${directory}/${program.name}.wgsl`, compiled.wgsl);
    results.push({
      name: program.name,
      sourceSHA256: sha(program.source),
      compiledSHA256: sha(compiled.wgsl),
      entries,
    });
  }
  const out = process.env.FORGEAX_BOUNDS_COMPOSITION_OUTPUT;
  if (out)
    writeFileSync(
      `${out}/consumer-audit.json`,
      JSON.stringify(
        {
          results,
          hardwareBoundary: 'Hardware factory strings only; no native Ray Query execution.',
        },
        null,
        2,
      ),
    );
}, 60_000);
