import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/compile';

const directory = new URL('../', import.meta.url);
const source = readFileSync(new URL('standard-deferred-lighting.wgsl', directory), 'utf8');
const modules: Record<string, string> = {};
for (const path of readdirSync(directory, { recursive: true })) {
  if (typeof path !== 'string' || !path.endsWith('.wgsl')) continue;
  const text = readFileSync(new URL(path, directory), 'utf8');
  const id = text.match(/^#define_import_path\s+(\S+)/m)?.[1];
  if (id !== undefined) modules[id] = text;
}
const imports: Record<string, string> = {};
function include(id: string): void {
  if (imports[id] !== undefined) return;
  const text = modules[id];
  if (text === undefined) throw new Error(`Missing shader import ${id}`);
  imports[id] = text;
  for (const match of text.matchAll(/^#import\s+([^\s{]+?)(?=::\{|\s|$)/gm)) {
    if (match[1] !== undefined) include(match[1]);
  }
}
include('forgeax_standard::deferred_lighting');

it('keeps the zero-transmission assumption local to the deferred directional gate', () => {
  // Transmitting materials require back-side directional shadows. Changing this
  // deferred ABI must revisit the no-contribution proof, not inherit this gate.
  expect(source).toMatch(
    /evaluateStandardDirect\(position, ndc, viewZ, normal, direction, albedo\.rgb, vec3<f32>\(0\.0\),/,
  );
});

const variants: Record<string, boolean>[] = [
  {},
  { STORAGE_BUFFER_AVAILABLE: true, CLUSTER_FORWARD_AVAILABLE: true },
  {
    STORAGE_BUFFER_AVAILABLE: true,
    CLUSTER_FORWARD_AVAILABLE: true,
    POINT_SHADOW_AVAILABLE: true,
    DIRECTIONAL_PCSS_AVAILABLE: true,
    DIRECT_DFG_LUT_AVAILABLE: true,
  },
];

it.each(
  variants,
)('retains the deferred shader ABI with optional lighting features %j', async (defines) => {
  const reference = source.replace(
    'receiveShadows && dot(normal, normalize(-view.lightDir)) > 0.0',
    'receiveShadows',
  );
  const options = { id: 'forgeax_standard::deferred_lighting', imports, defines };
  const before = await compileShader(reference, options);
  const after = await compileShader(source, options);
  if (!before.ok) throw before.error;
  if (!after.ok) throw after.error;
  expect(after.value.bindings).toEqual(before.value.bindings);
  expect(after.value.reflection).toEqual(before.value.reflection);
});
