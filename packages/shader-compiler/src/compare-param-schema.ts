// Validate the resources a material Pass consumes against the root binding numbers.

import type {
  BindGroupLayoutDescriptor,
  BindGroupLayoutEntry,
  ParamSchemaEntry,
} from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import { err, ok, type Result, ShaderError } from './errors.js';

// === Public API ====================================================================

/** Maximum allowed binding groups for material-shader entries (WebGPU spec). */
const MAX_BIND_GROUPS = 4;

/**
 * Pre-check for material-shader BGL overflow (AC-07).
 *
 * If the reflected BGL array length exceeds `MAX_BIND_GROUPS` (4), emit a
 * structured ShaderError with code='material-schema-mismatch' and
 * mismatchKind='bg-overflow'. This check runs before the schema-vs-BGL
 * comparison so the user sees a clear overflow signal rather than a
 * confusing type-mismatch.
 */
export function checkBindGroupOverflow(
  bgls: readonly BindGroupLayoutDescriptor[],
  materialShaderPath: string,
): Result<void, ShaderError> {
  if (bgls.length > MAX_BIND_GROUPS) {
    return err(
      new ShaderError({
        code: 'material-schema-mismatch',
        expected: `at most ${MAX_BIND_GROUPS} binding groups in a material-shader entry (WebGPU maxBindGroups)`,
        message: `material-shader '${materialShaderPath}' has ${bgls.length} binding groups (max ${MAX_BIND_GROUPS})`,
        hint: `reduce the number of @group annotations in the WGSL source to ${MAX_BIND_GROUPS} or fewer. The engine reserves @group(0) for view, @group(1) for mesh, @group(2) for material, and @group(3) for skybox/shadow. Material-shader user bindings must stay within @group(2).`,
        detail: {
          code: 'material-schema-mismatch',
          mismatchKind: 'bg-overflow',
          materialShaderPath,
          actualCount: bgls.length,
          maxAllowed: MAX_BIND_GROUPS,
        },
      }),
    );
  }
  return ok(undefined);
}

/**
 * Check the root-owned material bindings that occur in this Pass. Missing
 * resources are legal: a depth Pass may consume none, or a shading Pass may
 * consume only a texture subset. Engine-owned additions are checked by their
 * producer and renderer; this gate never reindexes the root resource slots.
 */
export function compareMaterialBindings(
  schema: readonly ParamSchemaEntry[],
  actualBgls: readonly BindGroupLayoutDescriptor[],
  materialShaderPath: string,
  ignoredParameters: ReadonlySet<string> = new Set(),
): Result<void, ShaderError> {
  // Standard physical textures are appended after engine injections in the
  // cooked ABI.  They must not shift the user-region bindings used by the
  // comparison of ordinary material resources; derive the checked slice from
  // the same filtered schema while keeping the physical declarations as
  // tolerated extras.
  const comparedSchema =
    ignoredParameters.size === 0
      ? schema
      : schema.filter((entry) => !ignoredParameters.has(entry.name));
  const derived = derive(comparedSchema);
  if (derived.bglEntries.length === 0) {
    return ok(undefined);
  }

  const actualByBinding = flattenByBinding(actualBgls);
  const expectedParamByBinding = paramNameByBinding(derived);
  const expectedDisplayNameByBinding = displayNameByBinding(derived);

  for (const expected of derived.bglEntries) {
    const expectedParameter = expectedParamByBinding.get(expected.binding);
    if (expectedParameter !== undefined && ignoredParameters.has(expectedParameter)) continue;
    const actual = actualByBinding.get(expected.binding);
    const paramName =
      expectedDisplayNameByBinding.get(expected.binding) ?? expectedParameter ?? '<merged-ubo>';
    if (actual === undefined) continue;
    if (!resourceKindCompatible(expected, actual)) {
      return err(
        makeBindingMismatch(
          'binding-type-mismatch',
          expected,
          actual,
          paramName,
          materialShaderPath,
        ),
      );
    }
  }
  return ok(undefined);
}

// === Helpers =======================================================================

function flattenByBinding(
  bgls: readonly BindGroupLayoutDescriptor[],
): Map<number, BindGroupLayoutEntry> {
  const out = new Map<number, BindGroupLayoutEntry>();
  // ParamSchema owns the material user region in group(1). Reflection also
  // returns scene/storage groups whose binding numbers legitimately overlap
  // the material slots (for example meshes at group(2)/binding(1)); flattening
  // those groups by binding alone made a valid material sampler look like a
  // storage-buffer mismatch. The compiler's reflection writer labels groups,
  // so prefer the material descriptor and retain the single-descriptor
  // fallback for older test/consumer payloads.
  const materialDescriptors = bgls.filter((descriptor) => descriptor.label === '@group(1)');
  const descriptors =
    bgls.length === 1 && bgls[0]?.label === undefined ? bgls : materialDescriptors;
  for (const descriptor of descriptors) {
    for (const entry of descriptor.entries) {
      if (!out.has(entry.binding)) out.set(entry.binding, entry);
    }
  }
  return out;
}

/**
 * Map each derived binding to the producer-owned parameter or resource name.
 * The derived interface already contains the binding facts, including the
 * coordinate UBO that texture-only schemas allocate before their resources.
 * Walking those facts avoids a second binding cursor in the compiler.
 */
function paramNameByBinding(derived: ReturnType<typeof derive>): Map<number, string> {
  const out = new Map<number, string>();
  const numericMembers = derived.numericMembers ?? [];
  const coordinateRecords = derived.coordinateRecords ?? [];
  const resourceBindings = derived.resourceBindings ?? [];
  const uniformEntry = derived.bglEntries.find((entry) => entry.buffer?.type === 'uniform');
  if (uniformEntry !== undefined) {
    const owner = numericMembers[0]?.name ?? coordinateRecords[0]?.parameter;
    if (owner !== undefined) out.set(uniformEntry.binding, owner);
  }
  for (const resource of resourceBindings) {
    // Auto-paired sampler resources carry the texture parameter in
    // `resource.parameter`; use it for the ignore projection so a relocated
    // physical texture skips both its sampler and view entries.
    out.set(resource.binding, resource.parameter ?? resource.name);
  }
  return out;
}

/** Keep diagnostics pointed at the concrete reflected resource name. */
function displayNameByBinding(derived: ReturnType<typeof derive>): Map<number, string> {
  const out = new Map<number, string>();
  for (const resource of derived.resourceBindings ?? []) {
    out.set(resource.binding, resource.name);
  }
  return out;
}

function resourceKindCompatible(
  expected: BindGroupLayoutEntry,
  actual: BindGroupLayoutEntry,
): boolean {
  if (expected.buffer !== undefined) {
    if (actual.buffer === undefined) return false;
    return expected.buffer.type === actual.buffer.type;
  }
  if (expected.texture !== undefined) {
    if (actual.texture === undefined) return false;
    if (expected.texture.viewDimension !== actual.texture.viewDimension) return false;
    // A generic MaterialAsset texture contract may be consumed through an
    // explicit-LOD path (`textureSampleLevel`), which naga reflects as an
    // unfilterable float view even though the authored contract remains the
    // ordinary filtering `texture2d` shape. The sampler check below applies
    // the same compatibility rule to the paired resource.
    if (
      expected.texture.sampleType !== actual.texture.sampleType &&
      !(
        expected.texture.sampleType === 'float' &&
        actual.texture.sampleType === 'unfilterable-float'
      )
    ) {
      return false;
    }
    return true;
  }
  if (expected.sampler !== undefined) {
    if (actual.sampler === undefined) return false;
    return (
      expected.sampler.type === actual.sampler.type ||
      (expected.sampler.type === 'filtering' && actual.sampler.type === 'non-filtering')
    );
  }
  if (expected.storageTexture !== undefined) {
    return actual.storageTexture !== undefined;
  }
  if (expected.externalTexture !== undefined) {
    // Naga reflects `texture_external` as a handle with no layout sub-object.
    return (
      actual.externalTexture !== undefined ||
      (actual.buffer === undefined &&
        actual.texture === undefined &&
        actual.sampler === undefined &&
        actual.storageTexture === undefined)
    );
  }
  return false;
}

function makeBindingMismatch(
  mismatchKind: 'binding-missing' | 'binding-type-mismatch',
  expected: BindGroupLayoutEntry,
  actual: BindGroupLayoutEntry | undefined,
  expectedParam: string,
  materialShaderPath: string,
): ShaderError {
  const wgslHint = synthesiseWgslHint(expected, expectedParam);
  const message =
    mismatchKind === 'binding-missing'
      ? `material-shader '${materialShaderPath}' is missing WGSL @binding(${expected.binding}) for paramSchema entry '${expectedParam}'`
      : `material-shader '${materialShaderPath}' WGSL @binding(${expected.binding}) resource kind does not match paramSchema entry '${expectedParam}'`;
  return new ShaderError({
    code: 'material-shader-binding-mismatch',
    expected: `WGSL @binding(${expected.binding}) declaring ${describeEntry(expected)} for paramSchema entry '${expectedParam}'`,
    message,
    hint: wgslHint,
    detail: {
      code: 'material-shader-binding-mismatch',
      mismatchKind,
      materialShaderPath,
      expected,
      ...(actual !== undefined ? { actual } : {}),
      expectedParam,
    },
  });
}

function describeEntry(entry: BindGroupLayoutEntry): string {
  if (entry.buffer !== undefined) {
    return entry.buffer.type === 'storage' || entry.buffer.type === 'read-only-storage'
      ? `var<storage> (${entry.buffer.type})`
      : 'var<uniform> ...';
  }
  if (entry.texture !== undefined) {
    return `texture (sampleType=${entry.texture.sampleType}, viewDimension=${entry.texture.viewDimension})`;
  }
  if (entry.sampler !== undefined) {
    return `sampler (type=${entry.sampler.type})`;
  }
  if (entry.storageTexture !== undefined) {
    return 'storage texture';
  }
  if (entry.externalTexture !== undefined) {
    return 'texture_external';
  }
  return 'unknown resource';
}

function synthesiseWgslHint(expected: BindGroupLayoutEntry, expectedParam: string): string {
  const at = `@group(2) @binding(${expected.binding})`;
  if (expected.buffer !== undefined) {
    return `add the missing WGSL declaration: ${at} var<uniform> ${expectedParam}: <Type>; (the paramSchema entry '${expectedParam}' is the first numeric field in the merged UBO; the struct itself collapses every numeric paramSchema entry into one std140-packed slot)`;
  }
  if (expected.texture !== undefined) {
    const wgslTexType =
      expected.texture.viewDimension === '2d' && expected.texture.sampleType === 'depth'
        ? 'texture_depth_2d'
        : expected.texture.viewDimension === 'cube'
          ? 'texture_cube<f32>'
          : expected.texture.viewDimension === 'cube-array'
            ? 'texture_cube_array<f32>'
            : expected.texture.viewDimension === '2d-array'
              ? 'texture_2d_array<f32>'
              : expected.texture.viewDimension === '3d'
                ? 'texture_3d<f32>'
                : 'texture_2d<f32>';
    return `add the missing WGSL declaration: ${at} var ${expectedParam}: ${wgslTexType};`;
  }
  if (expected.sampler !== undefined) {
    const wgslSamplerType =
      expected.sampler.type === 'comparison' ? 'sampler_comparison' : 'sampler';
    return `add the missing WGSL declaration: ${at} var ${expectedParam}: ${wgslSamplerType};`;
  }
  if (expected.externalTexture !== undefined) {
    return `add the missing WGSL declaration: ${at} var ${expectedParam}: texture_external;`;
  }
  if (expected.storageTexture !== undefined) {
    return `add the missing WGSL storage-texture declaration at ${at} for paramSchema entry '${expectedParam}'`;
  }
  return `add the missing WGSL declaration at ${at} for paramSchema entry '${expectedParam}'`;
}
