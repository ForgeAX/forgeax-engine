import { IRRADIANCE_FIELD_FRAME_BYTES } from '../../../render/src/raytracing/irradiance-field';
import { packWorldSource } from '../../../render/src/raytracing/world-traversal';
import { compileShader } from '../../../shader-compiler/src/index';
import { loadEngineShaderEntries } from '../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';

/** Live trace resources; bindings 7 and 8 belong to the diagnostic caller. */
const COVERAGE_RESOURCES: readonly (readonly [number, string])[] = [
  [0, 'probe-global.voxels'],
  [1, 'probe-global.settings'],
  [2, 'probe-global.instances'],
  [3, 'probe-global.fields'],
  [4, 'probe-global.bounds'],
  [5, 'probe-global.card-projections'],
  [6, 'irradiance-field.card-lit'],
  [9, 'irradiance-field.frame'],
  [10, 'probe-global.card-settings'],
  [11, 'cards.albedoRoughness'],
  [12, 'cards.normals'],
  [13, 'cards.emissionMetallic'],
  [14, 'cards.f0Validity'],
  [15, 'cards.depth'],
];

/** The RQ lighting Frame correctly has no software source. The independent SW
 * diagnostic borrows the accepted visibility publication, never patches that
 * live Frame or derives its expected epoch from the queried grid alone. */
export function coverageSoftwareFrame(
  frame: Uint8Array,
  visibility: Uint8Array,
  grid: Uint8Array,
  instancesBytes: number,
  fieldsBytes: number,
): Uint8Array {
  if (
    frame.byteLength !== IRRADIANCE_FIELD_FRAME_BYTES ||
    visibility.byteLength !== 64 ||
    grid.byteLength !== 64
  )
    throw new Error('Coverage requires the complete current Frame, visibility and grid contracts');
  const expected = Array.from(new Uint32Array(visibility.slice(48, 64).buffer)) as [
    number,
    number,
    number,
    number,
  ];
  const valid = packWorldSource({ traversal: 'global-sdf', expected });
  if (!valid.ok) throw valid.error;
  const words = new Uint32Array(grid.slice().buffer);
  if (
    expected[0] * 4 !== instancesBytes ||
    expected[1] * 4 !== fieldsBytes ||
    expected[2] !== words[7] ||
    expected.some((word, i) => word !== words[12 + i])
  )
    throw new Error(
      'Coverage visibility publication does not match the actual grid and bound source spans',
    );
  const result = frame.slice();
  new Uint32Array(result.buffer).set(expected, 28);
  return result;
}

/** Match native auto-layout reachability without changing the submitted WGSL. */
export async function coverageBindings(source: string) {
  const compiled = await compileShader(source, {
    computeEntry: 'classifyRays',
    imports: (await loadEngineShaderEntries()).imports,
  });
  if (!compiled.ok) throw compiled.error;
  const entry = compiled.value.manifestEntry.entryPoints?.find(
    (point) => point.name === 'classifyRays',
  );
  if (!entry) throw new Error('Coverage entry reflection is missing');
  for (const binding of [7, 8]) {
    if (!entry.bindings.some((item) => item.group === 0 && item.binding === binding))
      throw new Error(`Coverage caller binding ${binding} is missing`);
  }
  const active: (readonly [number, string])[] = [];
  for (const item of entry.bindings) {
    if (item.group === 0 && (item.binding === 7 || item.binding === 8)) continue;
    const resource = COVERAGE_RESOURCES.find(([binding]) => binding === item.binding);
    if (item.group !== 0 || !resource)
      throw new Error(`Unknown coverage resource ${item.group}:${item.binding}`);
    active.push(resource);
  }
  return active;
}
