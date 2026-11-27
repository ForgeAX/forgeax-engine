import type {
  ShaderReflection,
  ShaderReflectionBoundGlobal,
  ShaderReflectionTypeDescriptor,
  ShaderValueMemberReads,
} from '@forgeax/engine-types';
import { SURFACE_INPUT_FIELDS } from './compose.js';

type StructReads = ShaderValueMemberReads['structs'][number];

function surfaceFieldType(type: ShaderReflectionTypeDescriptor): string | undefined {
  if (type.kind === 'scalar') {
    if (type.scalarKind === 'bool' && type.width === 1) return 'bool';
    return type.scalarKind === 'float' && type.width === 4 ? 'f32' : undefined;
  }
  if (type.kind === 'vector' && type.scalarKind === 'float' && type.width === 4)
    return `vec${type.components}<f32>`;
  if (type.kind === 'matrix' && type.scalarKind === 'float' && type.width === 4)
    return `mat${type.columns}x${type.rows}<f32>`;
  return undefined;
}

function isSurfaceInput(row: StructReads): boolean {
  const members = row.typeDescriptor.members;
  return (
    members.length === SURFACE_INPUT_FIELDS.length &&
    SURFACE_INPUT_FIELDS.every(([, type], index) => {
      const member = members[index];
      return member !== undefined && surfaceFieldType(member.typeDescriptor) === type;
    })
  );
}

const RESOURCE_FACTS = [
  'addressSpace',
  'resourceKind',
  'resourceAccess',
  'textureClass',
  'viewDimension',
  'multisampled',
  'storageFormat',
] as const;

function sameResource(
  left: ShaderReflectionBoundGlobal,
  right: ShaderReflectionBoundGlobal,
): boolean {
  // Naga classifies unused float textures/samplers as unfilterable/non-filtering.
  // Their declaration is unchanged when a real Surface samples them. Actual
  // schema/layout still crosses compareDerivedMaterialInterface; filtering stays
  // in runtime's schema-derived BGL/device admission. Comparison samplers stay distinct.
  const sampleDeclaration = (type: ShaderReflectionBoundGlobal['sampleType']) =>
    type === 'float' || type === 'unfilterable-float' ? 'f32' : type;
  const samplerDeclaration = (type: ShaderReflectionBoundGlobal['samplerType']) =>
    type === 'filtering' || type === 'non-filtering' ? 'sampler' : type;
  return (
    RESOURCE_FACTS.every((field) => left[field] === right[field]) &&
    sampleDeclaration(left.sampleType) === sampleDeclaration(right.sampleType) &&
    samplerDeclaration(left.samplerType) === samplerDeclaration(right.samplerType)
  );
}

function inputFailure(
  input: StructReads,
  reflection: ShaderReflection,
  material: ShaderReflection,
): string | undefined {
  if (input.fields === undefined) return 'whole SurfaceInput aggregate consumption is unavailable';
  for (const [index, [field]] of SURFACE_INPUT_FIELDS.entries()) {
    if (field !== 'viewDirectionWS' && field !== 'frameTime') continue;
    const member = input.typeDescriptor.members[index];
    if (member === undefined || input.fields.includes(member.name))
      return `reads unavailable ${field}`;
  }
  if (input.consumerGlobals === undefined)
    return 'missing typed consumer global facts; recook with the current producer';
  for (const global of input.consumerGlobals) {
    if (global.kind !== 'bound' || global.group !== 1)
      return 'Surface consumer reads an unavailable renderer or private global';
    const actual = reflection.boundGlobals.find(
      (row) => row.group === global.group && row.binding === global.binding,
    );
    const expected = material.boundGlobals.find(
      (row) => row.group === global.group && row.binding === global.binding,
    );
    if (actual === undefined || expected === undefined || !sameResource(actual, expected))
      return 'Surface consumer resource does not match the derived Material interface';
  }
  return undefined;
}

/** The authoring owner separately rejects raw resource/entry interfaces in the entire Surface closure. */
export function staticCardContextFailure(
  reflection: ShaderReflection,
  material: ShaderReflection,
): string | undefined {
  for (const [name, stage] of [
    ['vs_card', 'vertex'],
    ['fs_card', 'fragment'],
  ] as const) {
    const entry = reflection.entryPoints?.find(
      (entry) => entry.name === name && entry.stage === stage,
    );
    const facts = entry?.valueReads;
    if (facts?.schemaVersion !== 'shader-value-member-reads/1')
      return `${name}: missing typed member facts; recook with the current producer`;
    const candidates = facts.structs.filter(isSurfaceInput);
    if (candidates.length === 0 && stage === 'vertex') continue;
    if (candidates.length !== 1)
      return `${name}: ${candidates.length === 0 ? 'missing' : 'ambiguous'} authoritative SurfaceInput shape`;
    const input = candidates[0];
    if (input === undefined) return `${name}: missing authoritative SurfaceInput shape`;
    const failure = inputFailure(input, reflection, material);
    if (failure !== undefined) return `${name}: ${failure}`;
  }
  return undefined;
}
