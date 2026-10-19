// reflection.ts — strict shader-reflection/2 reader and derived-interface check.

import {
  parseReflectionWire,
  type ShaderReflection,
  type ShaderReflectionBoundGlobal,
  type ShaderReflectionMember,
} from '@forgeax/engine-naga';
import type {
  BindGroupLayoutDescriptor,
  DerivedMaterialInterface,
  MaterialErrorFor,
  Result as MaterialResult,
} from '@forgeax/engine-types';
import { createMaterialError, err, MATERIAL_NUMERIC_LAYOUT, ok } from '@forgeax/engine-types';

/**
 * Parse the BGL JSON string emitted by naga emit_reflection.
 *
 * The generic bound-global wire is authoritative. The optional bindings
 * projection remains only as a downstream layout convenience; old raw arrays
 * and material-shaped projections are rejected by the Naga reader.
 *
 * Input = the @forgeax/engine-naga output format (byte-for-byte aligned with
 * @forgeax/engine-types.BindGroupLayoutDescriptor: label / entries / the 5 mutually
 * exclusive sub-dictionaries buffer / sampler / texture / storageTexture);
 * on failure throws SyntaxError, which the caller wraps as
 * ShaderError manifest-malformed.
 */
export interface ParsedReflection {
  readonly bindings: readonly BindGroupLayoutDescriptor[];
  readonly uvSetCount: number;
  readonly boundGlobals: readonly ShaderReflectionBoundGlobal[];
  readonly wire: ShaderReflection;
}

export function parseReflection(json: string): ParsedReflection {
  const wire = parseReflectionWire(json);
  const parsed = JSON.parse(json) as { bindings?: unknown };
  const bindings = Array.isArray(parsed.bindings)
    ? (parsed.bindings as readonly BindGroupLayoutDescriptor[])
    : [];
  return {
    bindings,
    uvSetCount: wire.uvSetCount,
    boundGlobals: wire.boundGlobals,
    wire,
  };
}

export function compareDerivedMaterialInterface(
  derived: DerivedMaterialInterface,
  reflection: Pick<ParsedReflection, 'boundGlobals'>,
  ignoredParameters: ReadonlySet<string> = new Set(),
  allowEngineResources = false,
  allowSceneRowPadding = false,
): MaterialResult<void, MaterialErrorFor<'material-derived-interface-mismatch'>> {
  const expectedMembers = expectedMaterialMembers(derived);
  const actualByCoordinate = new Map(
    reflection.boundGlobals.map((global) => [`${global.group}:${global.binding}`, global]),
  );
  // The Standard cooker compacts physical texture declarations after the
  // engine-owned IBL/transmission injections.  Preserve the full derived UBO
  // (including texture coordinate members), but project ordinary resource
  // bindings through the filtered user-region schema so a physical texture
  // cannot move emissive/occlusion/transmission resources during comparison.
  const comparedResourceBindings = new Map<string, number>();
  let nextResourceBinding = derived.resourceBindings[0]?.binding ?? 0;
  for (const resource of derived.resourceBindings) {
    if (resource.parameter !== undefined && ignoredParameters.has(resource.parameter)) continue;
    comparedResourceBindings.set(resource.name, nextResourceBinding);
    nextResourceBinding += 1;
  }
  const expectedGlobals = derived.bglEntries;
  const admittedBindings = new Set([
    ...comparedResourceBindings.values(),
    ...expectedGlobals
      .filter((entry) => entry.buffer?.type === 'uniform')
      .map((entry) => entry.binding),
  ]);
  if (!allowEngineResources) {
    for (const actual of reflection.boundGlobals) {
      if (actual.group === derived.group && !admittedBindings.has(actual.binding)) {
        return interfaceMismatch(derived, actual.name ?? '<undeclared-binding>', undefined, {
          group: actual.group,
          binding: actual.binding,
          resourceKind: actual.resourceKind,
        });
      }
    }
  }
  const uniform = expectedGlobals.find((entry) => entry.buffer?.type === 'uniform');
  for (const expected of expectedGlobals) {
    const resource = derived.resourceBindings.find((entry) => entry.binding === expected.binding);
    if (resource?.parameter !== undefined && ignoredParameters.has(resource.parameter)) continue;
    const projectedBinding =
      resource === undefined
        ? expected.binding
        : (comparedResourceBindings.get(resource.name) ?? expected.binding);
    const projectedExpected =
      projectedBinding === expected.binding ? expected : { ...expected, binding: projectedBinding };
    const actual = actualByCoordinate.get(`${derived.group}:${projectedBinding}`);
    if (actual === undefined) continue;
    const kindMatches = resourceKindMatches(projectedExpected, actual);
    // Stage visibility comes from the compiled program's actual layout.
    // The root owns storage offsets, not which render stage reads each value.
    if (!kindMatches) {
      return interfaceMismatch(
        derived,
        parameterForBinding(derived, expected.binding),
        { group: derived.group, binding: projectedBinding },
        { group: actual.group, binding: actual.binding, resourceKind: actual.resourceKind },
      );
    }
    if (uniform !== undefined && expected.binding === uniform.binding) {
      const actualMembers = actual.members ?? [];
      const expectedRawEnd = expectedMembers.reduce(
        (end, member) => Math.max(end, member.offset + member.reflectedSize),
        0,
      );
      const expectedRawAlignment = expectedMembers.reduce(
        (alignment, member) => Math.max(alignment, member.alignment),
        1,
      );
      const expectedRawSpan = roundUp(expectedRawEnd, expectedRawAlignment);
      const expectedAllocationSpan = roundUp(expectedRawSpan, 16);
      // Naga reports the logical WGSL struct span. The derived interface
      // reports the host allocation span, which is rounded to 16 bytes.
      const hasSceneRowPadding =
        allowSceneRowPadding &&
        actual.span !== undefined &&
        actual.span >= expectedRawSpan &&
        actualMembers.length >= expectedMembers.length &&
        actualMembers
          .slice(expectedMembers.length)
          .every((member) => member.name.startsWith('_gpuDrivenPadding'));
      if (
        (!hasSceneRowPadding && actual.span !== expectedRawSpan) ||
        expectedAllocationSpan !== derived.totalBytes
      ) {
        return interfaceMismatch(
          derived,
          expectedMembers[0]?.parameter ?? '<uniform-span>',
          { group: derived.group, binding: projectedBinding, span: expectedRawSpan },
          {
            group: actual.group,
            binding: actual.binding,
            ...(actual.span === undefined ? {} : { span: actual.span }),
          },
        );
      }
      if (!hasSceneRowPadding && actualMembers.length !== expectedMembers.length) {
        return interfaceMismatch(derived, '<uniform-span>');
      }
      for (let index = 0; index < expectedMembers.length; index += 1) {
        const expectedMember = expectedMembers[index];
        const actualMember = actualMembers[index];
        if (
          expectedMember === undefined ||
          actualMember === undefined ||
          !sameMember(expectedMember, actualMember)
        ) {
          return interfaceMismatch(
            derived,
            expectedMember?.parameter ?? '<member>',
            expectedMember === undefined
              ? undefined
              : {
                  member: expectedMember.name,
                  type: expectedMember.type,
                  offset: expectedMember.offset,
                  size: expectedMember.reflectedSize,
                  alignment: expectedMember.alignment,
                },
            actualMember === undefined
              ? undefined
              : {
                  member: actualMember.name,
                  type: actualMember.type,
                  offset: actualMember.offset,
                  size: actualMember.size,
                  alignment: actualMember.alignment,
                },
          );
        }
      }
    }
  }
  return ok(undefined);
}

/**
 * Validate the concrete storage buffers consumed by a scene-index entry.
 *
 * The material receipt carries a host page size, but that declaration is only
 * safe when the selected Naga module agrees on the actual array stride,
 * element struct span, member offsets, and fixed binding addresses. Keep this
 * check beside the raw reflection reader so a token/name match can never
 * publish an indirect draw ABI. Medium templates pass no derived material
 * fields: their row is opaque, while storage addresses, strides and span
 * retain the same contract.
 */
export function validateSceneIndexStorage(
  derived: DerivedMaterialInterface | undefined,
  reflection: Pick<ParsedReflection, 'boundGlobals' | 'bindings'>,
  rowStride: number,
  visibleItemsBinding: number,
): string | undefined {
  const scene = reflection.boundGlobals.find(
    (global) => global.group === 1 && global.binding === 46,
  );
  const sceneFailure = validateStorageGlobal(
    scene,
    reflection.bindings,
    'sceneMaterials',
    rowStride,
    1,
    46,
  );
  if (sceneFailure !== undefined) return sceneFailure;
  if (scene?.span !== rowStride) {
    return `sceneMaterials element span ${String(scene?.span)} does not match row stride ${rowStride}`;
  }
  if (derived !== undefined) {
    const expectedMembers = expectedMaterialMembers(derived);
    const actualMembers = scene.members ?? [];
    if (actualMembers.length < expectedMembers.length) {
      return `sceneMaterials element exposes ${actualMembers.length} members; expected ${expectedMembers.length}`;
    }
    for (let index = 0; index < expectedMembers.length; index += 1) {
      const expected = expectedMembers[index];
      const actual = actualMembers[index];
      if (expected === undefined || actual === undefined || !sameMember(expected, actual)) {
        return `sceneMaterials member ${expected?.name ?? String(index)} does not match the derived row layout`;
      }
    }
    if (
      actualMembers
        .slice(expectedMembers.length)
        .some((member) => !member.name.startsWith('_gpuDrivenPadding'))
    ) {
      return 'sceneMaterials has an undeclared storage member after the derived row fields';
    }
  }

  const visible = reflection.boundGlobals.find(
    (global) => global.group === 3 && global.binding === visibleItemsBinding,
  );
  return validateStorageGlobal(
    visible,
    reflection.bindings,
    'visibleItems',
    16,
    3,
    visibleItemsBinding,
  );
}

function validateStorageGlobal(
  global: ShaderReflectionBoundGlobal | undefined,
  bindings: ParsedReflection['bindings'],
  name: string,
  elementStride: number,
  group: number,
  binding: number,
): string | undefined {
  if (global === undefined) {
    return `${name} storage binding must be @group(${group}) @binding(${binding})`;
  }
  if (global.addressSpace !== 'storage' || global.resourceKind !== 'storage-buffer') {
    return `${name} @group(${group}) @binding(${binding}) must be a read-only storage buffer`;
  }
  if (global.elementStride !== elementStride) {
    return `${name} storage array stride ${String(global.elementStride)} does not match ${elementStride}`;
  }
  const groupLabel = `@group(${group})`;
  const groupLayout = bindings.find((layout) => layout.label === groupLabel);
  const entry = groupLayout?.entries.find((candidate) => candidate.binding === binding);
  if (entry === undefined || entry.buffer?.type !== 'read-only-storage') {
    return `${name} @group(${group}) @binding(${binding}) must use read-only storage in the reflected bind-group layout`;
  }
  return undefined;
}

function parameterForBinding(derived: DerivedMaterialInterface, binding: number): string {
  const resource = derived.resourceBindings.find((entry) => entry.binding === binding);
  if (resource?.parameter !== undefined) return resource.parameter;
  if (resource !== undefined) return resource.name;
  const member = derived.numericMembers[0];
  return member?.name ?? '<binding>';
}

interface ExpectedMaterialMember {
  readonly parameter: string;
  readonly name: string;
  readonly type: string;
  readonly offset: number;
  readonly size: number;
  readonly reflectedSize: number;
  readonly alignment: number;
}

function expectedMaterialMembers(derived: DerivedMaterialInterface): ExpectedMaterialMember[] {
  const members: ExpectedMaterialMember[] = (derived.numericMembers ?? []).map((member) => ({
    parameter: member.name,
    name: member.name,
    type: MATERIAL_NUMERIC_LAYOUT[member.type].wgslType,
    offset: member.offset,
    // A vec3 occupies a 16-byte tail in a WGSL struct even though its
    // reflected member payload is 12 bytes; this is the raw struct span.
    size: Math.max(member.size, member.alignment),
    reflectedSize: member.size,
    alignment: member.alignment,
  }));
  for (const coordinates of derived.coordinateRecords ?? []) {
    members.push(
      {
        parameter: coordinates.parameter,
        name: coordinates.transformMember,
        type: 'vec4<f32>',
        offset: coordinates.offset,
        size: 16,
        reflectedSize: 16,
        alignment: 16,
      },
      {
        parameter: coordinates.parameter,
        name: coordinates.metadataMember,
        type: 'vec4<f32>',
        offset: coordinates.offset + 16,
        size: 16,
        reflectedSize: 16,
        alignment: 16,
      },
      {
        parameter: coordinates.parameter,
        name: coordinates.rotationMember,
        type: 'vec4<f32>',
        offset: coordinates.offset + 32,
        size: 16,
        reflectedSize: 16,
        alignment: 16,
      },
    );
  }
  return members.sort((left, right) => left.offset - right.offset);
}

function roundUp(value: number, alignment: number): number {
  return value === 0 ? 0 : Math.ceil(value / alignment) * alignment;
}

function sameMember(expected: ExpectedMaterialMember, actual: ShaderReflectionMember): boolean {
  // Member spelling is not part of the buffer ABI. Naga renames legal author
  // identifiers (rainShelter0 -> rainShelter0_, with collision suffixes).
  // Declaration order and the complete physical layout remain authoritative;
  // retain both names only as diagnostics instead of duplicating Naga's namer.
  return (
    expected.type === actual.type &&
    expected.offset === actual.offset &&
    expected.reflectedSize === actual.size &&
    expected.alignment === actual.alignment
  );
}

function resourceKindMatches(
  expected: DerivedMaterialInterface['bglEntries'][number],
  actual: ShaderReflectionBoundGlobal,
): boolean {
  if (expected.buffer?.type === 'uniform') {
    return actual.addressSpace === 'uniform' && actual.resourceKind === 'buffer';
  }
  if (expected.buffer?.type === 'storage' || expected.buffer?.type === 'read-only-storage') {
    return actual.addressSpace === 'storage' && actual.resourceKind === 'storage-buffer';
  }
  if (expected.sampler !== undefined) {
    return actual.addressSpace === 'handle' && actual.resourceKind === 'sampler';
  }
  if (expected.texture !== undefined || expected.externalTexture !== undefined) {
    return actual.addressSpace === 'handle' && actual.resourceKind === 'texture';
  }
  return (
    expected.storageTexture !== undefined &&
    actual.addressSpace === 'handle' &&
    actual.resourceKind === 'texture'
  );
}

function interfaceMismatch(
  derived: DerivedMaterialInterface,
  parameter: string,
  expected?: MaterialErrorFor<'material-derived-interface-mismatch'>['detail']['expected'],
  actual?: MaterialErrorFor<'material-derived-interface-mismatch'>['detail']['actual'],
): MaterialResult<never, MaterialErrorFor<'material-derived-interface-mismatch'>> {
  return err(
    createMaterialError('material-derived-interface-mismatch', {
      code: 'material-derived-interface-mismatch',
      stage: 'compile',
      material: '<generated-material>',
      layoutIdentity: derived.layoutIdentity,
      parameter,
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual }),
      action: 'recook',
    }),
  );
}
