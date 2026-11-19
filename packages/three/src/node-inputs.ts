import { ok, type Result } from '@forgeax/engine-types';
import MaterialReferenceNode from 'three/src/nodes/accessors/MaterialReferenceNode.js';
import ReferenceBaseNode from 'three/src/nodes/accessors/ReferenceBaseNode.js';
import ReferenceNode from 'three/src/nodes/accessors/ReferenceNode.js';
import TextureNode from 'three/src/nodes/accessors/TextureNode.js';
import UserDataNode from 'three/src/nodes/accessors/UserDataNode.js';
import Node from 'three/src/nodes/core/Node.js';
import UniformNode from 'three/src/nodes/core/UniformNode.js';
import { Color, type Material, Texture, Vector2, Vector3, Vector4 } from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';
import { nodeDefinition } from './node-material-instance';
import {
  admitReference,
  isValueReference,
  type ReferenceInput,
  referenceValue,
} from './node-reference';
import { boundSurfaceRoot } from './node-surface';

// One fixed contract for admission, value reads and replaced image slots.
export const SURFACE_INPUTS = {
  colorNode: { kind: 'rgba', map: 'map' },
  opacityNode: { kind: 'scalar', map: 'alphaMap', min: 0, max: 1 },
  roughnessNode: { kind: 'scalar', map: 'roughnessMap', min: 0, max: 1 },
  metalnessNode: { kind: 'scalar', map: 'metalnessMap', min: 0, max: 1 },
  emissiveNode: { kind: 'rgb', map: 'emissiveMap' },
  clearcoatNode: { kind: 'scalar', map: 'clearcoatMap', min: 0, max: 1 },
  clearcoatRoughnessNode: { kind: 'scalar', map: 'clearcoatRoughnessMap', min: 0, max: 1 },
  sheenNode: { kind: 'rgb', map: 'sheenColorMap' },
  sheenRoughnessNode: { kind: 'scalar', map: 'sheenRoughnessMap', min: 0, max: 1 },
  specularIntensityNode: { kind: 'scalar', map: 'specularIntensityMap', min: 0, max: 1 },
  specularColorNode: { kind: 'rgb', map: 'specularColorMap' },
  iorNode: { kind: 'scalar', map: null, min: 1, max: Infinity },
  iridescenceNode: { kind: 'scalar', map: 'iridescenceMap', min: 0, max: 1 },
  iridescenceIORNode: { kind: 'scalar', map: null, min: 1, max: Infinity },
  iridescenceThicknessNode: {
    kind: 'scalar',
    map: 'iridescenceThicknessMap',
    min: 0,
    max: Infinity,
  },
  transmissionNode: { kind: 'scalar', map: 'transmissionMap', min: 0, max: 1 },
  thicknessNode: { kind: 'scalar', map: 'thicknessMap', min: 0, max: Infinity },
  attenuationDistanceNode: { kind: 'scalar', map: null, min: Number.MIN_VALUE, max: Infinity },
  attenuationColorNode: { kind: 'rgb01', map: null },
  rotationNode: {
    kind: 'scalar',
    map: null,
    min: -Infinity,
    max: Infinity,
    model: 'SpriteNodeMaterial',
  },
  scaleNode: {
    kind: 'vec2',
    map: null,
    min: Number.MIN_VALUE,
    max: Infinity,
    model: 'SpriteNodeMaterial',
  },
  positionNode: { kind: 'vec3', map: null, model: 'SpriteNodeMaterial' },
  offsetNode: { kind: 'scalar', map: null, min: -Infinity, max: Infinity },
  dashScaleNode: { kind: 'scalar', map: null, min: -Infinity, max: Infinity },
  dashSizeNode: { kind: 'scalar', map: null, min: Number.MIN_VALUE, max: Infinity },
  gapSizeNode: { kind: 'scalar', map: null, min: 0, max: Infinity },
} as const;
export type InputField = keyof typeof SURFACE_INPUTS;
const subjects = Object.fromEntries(
  Object.keys(SURFACE_INPUTS).map((field) => [field, `NodeMaterial.${field}`]),
) as Record<InputField, string>;
const mapInputs: Readonly<Record<string, InputField>> = Object.fromEntries(
  Object.entries(SURFACE_INPUTS).flatMap(([field, input]) =>
    input.map === null ? [] : [[input.map, field as InputField]],
  ),
);
type Input = UniformNode<unknown> | TextureNode | ReferenceInput;
const acceptedInput = ok(undefined);
const nonImageFlags = [
  'isCubeTexture',
  'isData3DTexture',
  'isDataArrayTexture',
  'isDepthTexture',
  'isFramebufferTexture',
  'isRenderTargetTexture',
  'isStorageTexture',
] as const;
function finite3(x: number, y: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}
function validRgb(field: InputField, x: number, y: number, z: number): boolean {
  return (
    finite3(x, y, z) &&
    (SURFACE_INPUTS[field].kind !== 'rgb01' ||
      (x >= 0 && x <= 1 && y >= 0 && y <= 1 && z >= 0 && z <= 1))
  );
}
const textureFields = [
  'uvNode',
  'levelNode',
  'biasNode',
  'compareNode',
  'depthNode',
  'gradNode',
  'gatherNode',
  'offsetNode',
  'referenceNode',
] as const;

function hooks(prototype: object): readonly (readonly [string, unknown])[] {
  const entries = new Map<string, unknown>();
  let current: object | null = prototype;
  while (current !== null && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      const value = Object.getOwnPropertyDescriptor(current, name)?.value;
      if (name !== 'constructor' && typeof value === 'function' && !entries.has(name))
        entries.set(name, value);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...entries];
}
const leafHooks = new Map<object, ReturnType<typeof hooks>>([
  [UniformNode, hooks(UniformNode.prototype)],
  [TextureNode, hooks(TextureNode.prototype)],
  [MaterialReferenceNode, hooks(MaterialReferenceNode.prototype)],
  [ReferenceNode, hooks(ReferenceNode.prototype)],
  [ReferenceBaseNode, hooks(ReferenceBaseNode.prototype)],
  [UserDataNode, hooks(UserDataNode.prototype)],
]);

/** Fixed leaf admission, never a graph evaluator. Source objects remain authoritative. */
export function admitSurfaceInput(
  material: Material,
  field: InputField,
  value: unknown,
): Result<void, Error> {
  const subject = subjects[field];
  const contract = SURFACE_INPUTS[field];
  const type = nodeDefinition(material).type;
  if ('model' in contract && type !== contract.model)
    return unsupported(`${subject} requires ${contract.model}`, material.uuid);
  if (type === 'MeshNormalNodeMaterial' || type === 'MeshMatcapNodeMaterial')
    return unsupported(`${subject} on Normal/Matcap model`, material.uuid);
  if (!(value instanceof Node))
    return unsupported(`${subject} requires a native uniform/texture leaf`, material.uuid);
  const leaf = value as Input;
  const admitted = admitLeaf(material, subject, leaf);
  if (!admitted.ok) return admitted;
  if (isValueReference(leaf)) {
    const reference = admitReferenceLeaf(material, field, leaf as ReferenceInput);
    if (!reference.ok) return reference;
  }
  if (leaf.constructor === TextureNode && (field === 'colorNode' || field === 'opacityNode'))
    return admitTextureInput(material, field, leaf as TextureNode);
  if (contract.kind === 'vec2' || contract.kind === 'vec3')
    return admitVectorInput(material, field, leaf);
  if (contract.kind === 'scalar')
    return admitScalarInput(material, field, leaf, contract.min, contract.max);
  return admitColorInput(material, field, leaf);
}

function admitLeaf(material: Material, subject: string, leaf: Input): Result<void, Error> {
  const methods = leafHooks.get(leaf.constructor);
  if (
    methods === undefined ||
    leaf.updateType !== (isValueReference(leaf) ? 'object' : 'none') ||
    leaf.updateBeforeType !== 'none' ||
    leaf.updateAfterType !== 'none'
  )
    return unsupported(
      `${subject} requires an original uniform/texture leaf without update callbacks`,
      material.uuid,
    );
  const precision = Reflect.get(leaf, 'precision');
  if (precision !== null && !(isValueReference(leaf) && precision === undefined))
    return unsupported(`${subject} precision override`, material.uuid);
  const source = leaf as unknown as Record<string, unknown>;
  for (const [name, method] of methods)
    if (source[name] !== method) return unsupported(`${subject}.${name} override`, material.uuid);
  return acceptedInput;
}

function admitReferenceLeaf(
  material: Material,
  field: InputField,
  input: ReferenceInput,
): Result<void, Error> {
  if ('model' in SURFACE_INPUTS[field])
    return unsupported(`${subjects[field]} reference requires a native pose path`, material.uuid);
  const invalid = admitReference(material, subjects[field], input);
  if (invalid !== undefined) return invalid;
  return input.node === null
    ? acceptedInput
    : admitLeaf(material, subjects[field], input.node as UniformNode<unknown>);
}

function inputType(input: Input): string | null {
  return isValueReference(input) ? (input as ReferenceInput).uniformType : input.nodeType;
}
function inputValue(material: Material, input: Input): unknown {
  if (isValueReference(input)) return referenceValue(material, input as ReferenceInput);
  return input.constructor === UniformNode ? (input as UniformNode<unknown>).value : undefined;
}

function admitVectorInput(material: Material, field: InputField, leaf: Input): Result<void, Error> {
  const contract = SURFACE_INPUTS[field];
  const subject = subjects[field];
  if (
    leaf.constructor !== UniformNode ||
    (leaf.nodeType !== null && leaf.nodeType !== contract.kind)
  )
    return unsupported(`${subject} requires an original ${contract.kind} uniform`, material.uuid);
  const value = inputValue(material, leaf);
  if (contract.kind === 'vec3' && value instanceof Vector3)
    return finite3(value.x, value.y, value.z) ? acceptedInput : invalid(subject, material.uuid);
  if (contract.kind === 'vec2' && value instanceof Vector2)
    return Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      value.x >= contract.min &&
      value.x <= contract.max &&
      value.y >= contract.min &&
      value.y <= contract.max
      ? acceptedInput
      : invalid(subject, material.uuid);
  return unsupported(
    `${subject} requires ${contract.kind === 'vec3' ? 'Vector3' : 'Vector2'} uniform data`,
    material.uuid,
  );
}

function admitScalarInput(
  material: Material,
  field: InputField,
  leaf: Input,
  min: number,
  max: number,
): Result<void, Error> {
  const subject = subjects[field];
  const value = inputValue(material, leaf);
  if (
    (leaf.constructor !== UniformNode && !isValueReference(leaf)) ||
    (inputType(leaf) !== null && inputType(leaf) !== 'float') ||
    typeof value !== 'number'
  )
    return unsupported(`${subject} requires a scalar float uniform`, material.uuid);
  return Number.isFinite(value) && value >= min && value <= max
    ? acceptedInput
    : invalid(subject, material.uuid);
}

function admitColorInput(material: Material, field: InputField, leaf: Input): Result<void, Error> {
  const subject = subjects[field];
  if (leaf.constructor !== UniformNode && !isValueReference(leaf))
    return unsupported(`${subject} requires a Color or vec3 uniform`, material.uuid);
  const value = inputValue(material, leaf);
  if (
    value instanceof Color &&
    (inputType(leaf) === null || inputType(leaf) === 'color' || inputType(leaf) === 'vec3')
  )
    return validRgb(field, value.r, value.g, value.b)
      ? acceptedInput
      : invalid(subject, material.uuid);
  if (value instanceof Vector3 && (inputType(leaf) === null || inputType(leaf) === 'vec3'))
    return validRgb(field, value.x, value.y, value.z)
      ? acceptedInput
      : invalid(subject, material.uuid);
  if (
    field === 'colorNode' &&
    value instanceof Vector4 &&
    (inputType(leaf) === null || inputType(leaf) === 'vec4')
  )
    return validRgba(value) ? acceptedInput : invalid(subject, material.uuid);
  return unsupported(
    field === 'colorNode'
      ? `${subject} requires a Color, vec3 or vec4 uniform`
      : `${subject} requires a Color or vec3 uniform`,
    material.uuid,
  );
}

function validRgba(value: Vector4): boolean {
  return (
    finite3(value.x, value.y, value.z) && Number.isFinite(value.w) && value.w >= 0 && value.w <= 1
  );
}

function admitTextureInput(
  material: Material,
  field: InputField,
  node: TextureNode,
): Result<void, Error> {
  for (const name of textureFields)
    if ((node as unknown as Record<string, unknown>)[name] !== null)
      return unsupported(
        `NodeMaterial.${field}.${name} requires native graph conversion`,
        material.uuid,
      );
  if (
    !(node.value instanceof Texture) ||
    node.nodeType !== null ||
    node.sampler !== true ||
    node.updateMatrix !== true
  )
    return unsupported(
      `NodeMaterial.${field} requires an ordinary sampled 2D TextureNode`,
      material.uuid,
    );
  const value = node.value as unknown as Record<string, unknown>;
  if (nonImageFlags.some((name) => value[name] === true))
    return unsupported(
      `NodeMaterial.${field} requires a supported 2D image texture`,
      material.uuid,
    );
  return acceptedInput;
}

export function surfaceInput(material: Material, field: InputField): Input | null {
  // Transform preparation must not enter invalid/nested instance getters.
  if ('isNodeMaterialInstance' in material && nodeDefinition(material) === material) return null;
  if (!('isNodeMaterial' in material) || material.isNodeMaterial !== true) return null;
  return (material as unknown as Record<InputField, Input | null>)[field] ?? null;
}
export function surfaceTexture(material: Material, field: InputField): Texture | null {
  if (boundSurfaceRoot(material, field)) return null;
  const input = surfaceInput(material, field);
  return input !== null && 'isTextureNode' in input && input.isTextureNode === true
    ? (input.value as Texture)
    : null;
}

/** Reuse the existing material payload; no cloned Material or per-node state mirror. */
export function surfaceColor(
  material: Material & { color?: Color },
): [number, number, number, number] {
  const colorInput = boundSurfaceRoot(material, 'colorNode')
    ? null
    : surfaceInput(material, 'colorNode');
  const opacityInput = boundSurfaceRoot(material, 'opacityNode')
    ? null
    : surfaceInput(material, 'opacityNode');
  const alpha = boundSurfaceRoot(material, 'opacityNode')
    ? 1
    : opacityInput === null
      ? material.opacity
      : opacityInput.constructor === TextureNode
        ? 1
        : (inputValue(material, opacityInput) as number);
  if (boundSurfaceRoot(material, 'colorNode')) return [1, 1, 1, alpha];
  if (colorInput === null)
    return [material.color?.r ?? 1, material.color?.g ?? 1, material.color?.b ?? 1, alpha];
  if (colorInput.constructor === TextureNode) return [1, 1, 1, alpha];
  const color = inputValue(material, colorInput);
  if (color instanceof Color) return [color.r, color.g, color.b, alpha];
  if (color instanceof Vector4) return [color.x, color.y, color.z, color.w * alpha];
  const vector = color as Vector3;
  return [vector.x, vector.y, vector.z, alpha];
}

/** Constant-time slot lookup, including the build-only Physical recipe path. */
export function replacesTexture(material: Material, map: string): boolean {
  const field = mapInputs[map];
  return field !== undefined && surfaceInput(material, field) !== null;
}
function uniformValue(material: Material, field: InputField): unknown {
  const input = surfaceInput(material, field);
  // Transform preparation precedes material admission; never evaluate a rejected graph getter.
  if (input === null) return undefined;
  if (isValueReference(input) && 'model' in SURFACE_INPUTS[field]) return undefined;
  return inputValue(material, input);
}
export function surfaceScalar(material: Material, field: InputField, fallback: number): number {
  if (boundSurfaceRoot(material, field)) return field === 'roughnessNode' ? 1 : 0;
  const value = uniformValue(material, field);
  return typeof value === 'number' ? value : fallback;
}
export function surfaceRgb(
  material: Material,
  field: InputField,
  fallback: Color,
  factor = 1,
): [number, number, number] {
  if (boundSurfaceRoot(material, field)) return [0, 0, 0];
  const input = surfaceInput(material, field);
  if (input === null) return [fallback.r * factor, fallback.g * factor, fallback.b * factor];
  const value = inputValue(material, input);
  if (value instanceof Color) return [value.r, value.g, value.b];
  const vector = value as Vector3;
  return [vector.x, vector.y, vector.z];
}

/** Three selects transmission ordering and double passes by node presence, even at value zero. */
export function usesTransmission(material: Material): boolean {
  return (
    ('transmission' in material && Number(material.transmission) > 0) ||
    surfaceInput(material, 'transmissionNode') !== null
  );
}

/** Read caller-owned vectors; no cloned node or per-frame input array. */
export function surfaceVec2(material: Material, field: InputField): Vector2 | null {
  const value = uniformValue(material, field);
  return value instanceof Vector2 ? value : null;
}
export function surfaceVec3(material: Material, field: InputField): Vector3 | null {
  const value = uniformValue(material, field);
  return value instanceof Vector3 ? value : null;
}
