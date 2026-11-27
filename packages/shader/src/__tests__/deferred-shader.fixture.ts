import { readdirSync, readFileSync } from 'node:fs';

const directory = new URL('../', import.meta.url);
export const deferredShaderSource = readFileSync(
  new URL('standard-deferred-lighting.wgsl', directory),
  'utf8',
);
const modules: Record<string, string> = {};
for (const path of readdirSync(directory, { recursive: true })) {
  if (typeof path !== 'string' || !path.endsWith('.wgsl')) continue;
  const text = readFileSync(new URL(path, directory), 'utf8');
  const id = text.match(/^#define_import_path\s+(\S+)/m)?.[1];
  if (id !== undefined) modules[id] = text;
}
export const deferredShaderImports: Record<string, string> = {};
function include(id: string): void {
  if (deferredShaderImports[id] !== undefined) return;
  const text = modules[id];
  if (text === undefined) throw new Error(`Missing shader import ${id}`);
  deferredShaderImports[id] = text;
  for (const match of text.matchAll(/^#import\s+([^\s{]+?)(?=::\{|\s|$)/gm)) {
    if (match[1] !== undefined) include(match[1]);
  }
}
include('forgeax_standard::deferred_lighting');
include('forgeax_pbr::gbuffer_output');
