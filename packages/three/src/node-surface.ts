import {
  err,
  type MaterialAsset,
  type MaterialParameter,
  ok,
  type Result,
  sha256,
} from '@forgeax/engine-types';
import MaterialReferenceNode from 'three/src/nodes/accessors/MaterialReferenceNode.js';
import ReferenceBaseNode from 'three/src/nodes/accessors/ReferenceBaseNode.js';
import ReferenceNode from 'three/src/nodes/accessors/ReferenceNode.js';
import TextureNode from 'three/src/nodes/accessors/TextureNode.js';
import UserDataNode from 'three/src/nodes/accessors/UserDataNode.js';
import AttributeNode from 'three/src/nodes/core/AttributeNode.js';
import ConstNode from 'three/src/nodes/core/ConstNode.js';
import Node from 'three/src/nodes/core/Node.js';
import { objectGroup } from 'three/src/nodes/core/UniformGroupNode.js';
import UniformNode from 'three/src/nodes/core/UniformNode.js';
import ConditionalNode from 'three/src/nodes/math/ConditionalNode.js';
import MathNode from 'three/src/nodes/math/MathNode.js';
import OperatorNode from 'three/src/nodes/math/OperatorNode.js';
import ConvertNode from 'three/src/nodes/utils/ConvertNode.js';
import JoinNode from 'three/src/nodes/utils/JoinNode.js';
import SplitNode from 'three/src/nodes/utils/SplitNode.js';
import {
  type BufferGeometry,
  CanvasTexture,
  Color,
  ColorManagement,
  DataTexture,
  LinearSRGBColorSpace,
  Material,
  NoColorSpace,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
} from 'three/src/Three.Core.js';
import { ThreeCompatibilityError } from './errors';
import { admitNodeMaterial } from './node-materials';
import { admitReference, isValueReference, referenceValue } from './node-reference';

export const SURFACE_ROOTS = [
  'colorNode',
  'roughnessNode',
  'metalnessNode',
  'emissiveNode',
  'opacityNode',
  'alphaTestNode',
] as const;
export type SurfaceRoot = (typeof SURFACE_ROOTS)[number];
type ValueType = 'float' | 'vec2' | 'vec3' | 'vec4' | 'bool';
const operatorNames = ['+', '-', '*', '/', '<', '<=', '>', '>=', '==', '!='] as const;
const unaryNames = [
  'abs',
  'floor',
  'ceil',
  'round',
  'fract',
  'sin',
  'cos',
  'sqrt',
  'exp',
  'log',
  'sign',
  'negate',
  'saturate',
  'oneMinus',
  'normalize',
  'length',
] as const;
const binaryNames = ['min', 'max', 'pow', 'dot', 'step', 'mod'] as const;
const ternaryNames = ['mix', 'clamp', 'smoothstep'] as const;
type Operation =
  | (typeof operatorNames)[number]
  | (typeof unaryNames)[number]
  | (typeof binaryNames)[number]
  | (typeof ternaryNames)[number];
const operators = new Set<string>(operatorNames),
  unary = new Set<string>(unaryNames),
  binary = new Set<string>([...operatorNames, ...binaryNames]),
  ternary = new Set<string>(ternaryNames);
function isOperation(value: string): value is Operation {
  return unary.has(value) || binary.has(value) || ternary.has(value);
}
type Source = Record<string, unknown>;
export type SurfaceFailure =
  | 'unsupported-node'
  | 'unsafe-hook'
  | 'dependency'
  | 'cycle'
  | 'budget'
  | 'type'
  | 'value'
  | 'recipe-mismatch'
  | 'rebind-required';
export class ThreeSurfaceError extends ThreeCompatibilityError {
  declare readonly detail: {
    readonly subject: string;
    readonly uuid: string;
    readonly path: string;
    readonly reason: SurfaceFailure;
  };
  constructor(material: Material, path: string, reason: SurfaceFailure, message: string) {
    super(
      reason === 'rebind-required' || reason === 'recipe-mismatch'
        ? 'three-migration-required'
        : reason === 'value'
          ? 'three-invalid-value'
          : 'three-unsupported',
      `NodeMaterial.${path}: ${message}`,
      'Use the supported surface subset and explicitly bind a matching cooked recipe after structural edits.',
      material.uuid,
    );
    this.detail = Object.freeze({
      subject: this.detail.subject,
      uuid: material.uuid,
      path,
      reason,
    });
  }
}
export interface ThreeSurfaceRecipe {
  readonly version: 'three-r187-surface/1';
  readonly graphKey: string;
  /** Cook identity includes the verified compiler fingerprint. */
  readonly programGuid: string;
}
export interface SurfaceExpression {
  readonly type: ValueType;
  readonly op: Operation | 'const' | 'input' | 'uv' | 'texture' | 'split' | 'construct' | 'select';
  readonly args: readonly number[];
  readonly data?: string | readonly number[];
}
interface LiveInput {
  readonly name: string;
  readonly type: ValueType;
  readonly node: Node;
  readonly path: string;
}
interface LiveTexture {
  readonly name: string;
  readonly node: TextureNode;
  readonly path: string;
  readonly contract: string;
}
export interface NormalizedSurface {
  readonly model: 'standard' | 'unlit';
  readonly expressions: readonly SurfaceExpression[];
  readonly roots: Partial<Record<SurfaceRoot, number>>;
  readonly graphKey: string;
  readonly parameters: readonly MaterialParameter[];
  readonly uvSets: readonly number[];
  readonly ordinaryMaps: readonly string[];
  readonly inputs: readonly LiveInput[];
  readonly textures: readonly LiveTexture[];
}
interface Binding {
  readonly recipe: ThreeSurfaceRecipe;
  readonly graph: NormalizedSurface;
  readonly roots: readonly unknown[];
}
const bindings = new WeakMap<Material, Binding>();
/** SceneProjection borrows ordinary raster state with one Object.create(material) view. */
function bindingFor(material: Material): Binding | undefined {
  return bindings.get(material) ?? bindings.get(Object.getPrototypeOf(material) as Material);
}
const recipeSelection = Symbol('threeSurfaceRecipe');
type SurfaceProjection = MaterialAsset & { readonly [recipeSelection]?: ThreeSurfaceRecipe };
export function surfaceProgram(material: MaterialAsset): ThreeSurfaceRecipe | undefined {
  return (material as SurfaceProjection)[recipeSelection];
}
/** Planning metadata survives raster-state copies, but is never native asset content. */
export function clearSurfaceProgramSelection(material: MaterialAsset): void {
  Reflect.deleteProperty(material, recipeSelection);
}
export function hasSurfaceBinding(material: Material): boolean {
  return bindingFor(material) !== undefined;
}
export function boundSurfaceRoot(material: Material, field: string): boolean {
  return bindingFor(material)?.graph.roots[field as SurfaceRoot] !== undefined;
}
const source = (value: object) => value as Source;
const structuralJson = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'number' && Object.is(item, -0) ? { negativeZero: true } : item,
  );
const widths: Record<ValueType, number> = { float: 1, vec2: 2, vec3: 3, vec4: 4, bool: 1 };
const wgslTypes = { float: 'f32', vec2: 'vec2', vec3: 'vec3', vec4: 'vec4', bool: 'bool' } as const;
function valueType(value: unknown, declared: unknown): ValueType | undefined {
  const inferred =
    typeof value === 'number'
      ? 'float'
      : typeof value === 'boolean'
        ? 'bool'
        : value instanceof Color || value instanceof Vector3
          ? 'vec3'
          : value instanceof Vector2
            ? 'vec2'
            : value instanceof Vector4
              ? 'vec4'
              : undefined;
  return declared === null ||
    declared === undefined ||
    (declared === 'color' && inferred === 'vec3') ||
    declared === inferred
    ? inferred
    : undefined;
}
function numbers(value: unknown): readonly number[] | undefined {
  if (typeof value === 'number') return [value];
  if (value instanceof Color) return [value.r, value.g, value.b];
  if (value instanceof Vector2) return [value.x, value.y];
  if (value instanceof Vector3) return [value.x, value.y, value.z];
  if (value instanceof Vector4) return [value.x, value.y, value.z, value.w];
  return undefined;
}
function originalMethods(initial: object): readonly (readonly [string, unknown])[] {
  const entries = new Map<string, unknown>();
  let prototype: object | null = initial;
  while (prototype !== null && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const value = Object.getOwnPropertyDescriptor(prototype, name)?.value;
      if (name !== 'constructor' && typeof value === 'function' && !entries.has(name))
        entries.set(name, value);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return [...entries];
}
const nodeClasses = [
  ConstNode,
  UniformNode,
  TextureNode,
  OperatorNode,
  MathNode,
  ConditionalNode,
  JoinNode,
  SplitNode,
  ConvertNode,
  AttributeNode,
  MaterialReferenceNode,
  ReferenceBaseNode,
  ReferenceNode,
  UserDataNode,
] as const;
const methods = new Map<object, readonly (readonly [string, unknown])[]>(
  nodeClasses.map((ctor) => [ctor, originalMethods(ctor.prototype)]),
);
const originalConstructors = new Map<object, object>(
  nodeClasses.map((ctor) => [ctor.prototype, ctor]),
);
function dataProperty(initial: object, name: string): unknown {
  let owner: object | null = initial;
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor !== undefined) return descriptor.value;
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return undefined;
}
function pristine(node: Node): boolean {
  const ctor = originalConstructors.get(Object.getPrototypeOf(node) as object);
  const expected = ctor === undefined ? undefined : methods.get(ctor);
  if (
    expected === undefined ||
    dataProperty(node, 'constructor') !== ctor ||
    Object.values(Object.getOwnPropertyDescriptors(node)).some(
      (d) => d.get !== undefined || d.set !== undefined,
    )
  )
    return false;
  return (
    expected.every(([name, value]) => dataProperty(node, name) === value) &&
    Object.values(node).every((value) => typeof value !== 'function')
  );
}
const textureKinds = new Map<object, string>([
  [Texture, 'image'],
  [DataTexture, 'data'],
  [CanvasTexture, 'canvas'],
]);
function textureContract(texture: Texture): string {
  return JSON.stringify([
    textureKinds.get(texture.constructor),
    texture.colorSpace,
    texture.channel,
    texture.format,
    texture.type,
  ]);
}
const colorSpaces = new Set<string>([NoColorSpace, LinearSRGBColorSpace, SRGBColorSpace]);
const ordinaryMaps = [
  'map',
  'normalMap',
  'bumpMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'alphaMap',
  'aoMap',
  'displacementMap',
] as const;
const replacedMaps: Record<string, SurfaceRoot> = {
  map: 'colorNode',
  roughnessMap: 'roughnessNode',
  metalnessMap: 'metalnessNode',
  emissiveMap: 'emissiveNode',
  alphaMap: 'opacityNode',
};
function ordinaryTextureMembership(
  material: Material,
  roots: NormalizedSurface['roots'],
): readonly string[] {
  return ordinaryMaps.filter(
    (name) => source(material)[name] != null && !((replacedMaps[name] ?? '') in roots),
  );
}
function textureValid(texture: unknown): texture is Texture {
  if (!(texture instanceof Texture) || !textureKinds.has(texture.constructor)) return false;
  return (
    texture.format === RGBAFormat &&
    texture.type === UnsignedByteType &&
    colorSpaces.has(texture.colorSpace) &&
    ![
      'isCubeTexture',
      'isData3DTexture',
      'isDataArrayTexture',
      'isDepthTexture',
      'isFramebufferTexture',
      'isRenderTargetTexture',
      'isStorageTexture',
      'isVideoTexture',
    ].some((name) => source(texture)[name] === true) &&
    Number.isInteger(texture.channel) &&
    texture.channel >= 0 &&
    texture.channel <= 3
  );
}

/** Walk only at authoring/bind time. The result is a private typed DAG, never a public shader DSL. */
export function normalizeThreeSurface(
  material: Material,
): Result<NormalizedSurface, ThreeSurfaceError> {
  const fail = (path: string, reason: SurfaceFailure, message: string): never => {
    throw new ThreeSurfaceError(material, path, reason, message);
  };
  try {
    if (!['MeshStandardNodeMaterial', 'MeshBasicNodeMaterial'].includes(material.type))
      fail(
        'material',
        'unsupported-node',
        'expression recipes require exact Standard or Basic NodeMaterial',
      );
    if (
      material.onBeforeCompile !== Material.prototype.onBeforeCompile ||
      material.onBeforeRender !== Material.prototype.onBeforeRender ||
      SURFACE_ROOTS.some((root) => {
        const descriptor = Object.getOwnPropertyDescriptor(material, root);
        return descriptor?.get !== undefined || descriptor?.set !== undefined;
      })
    )
      fail('material', 'unsafe-hook', 'material callbacks and root accessors are unsupported');
    const admission = admitNodeMaterial(material, true);
    if (!admission.ok) fail('material', 'unsafe-hook', admission.error.message);
    if (ColorManagement.workingColorSpace !== LinearSRGBColorSpace)
      fail(
        'colorSpace',
        'unsupported-node',
        'surface recipes require linear-sRGB working color space',
      );
    const model = material.type === 'MeshBasicNodeMaterial' ? 'unlit' : 'standard';
    if (source(material).lights !== true)
      fail(
        'lights',
        'unsupported-node',
        'expression recipes retain the original model lighting policy',
      );
    const expressions: SurfaceExpression[] = [],
      inputs: LiveInput[] = [],
      textures: LiveTexture[] = [];
    const roots: Partial<Record<SurfaceRoot, number>> = {};
    const visited = new Map<Node, number>(),
      active = new Set<Node>();
    const canonical = new Map<string, number>();
    let sourceNodes = 0;
    const add = (expression: SurfaceExpression) => {
      const key = structuralJson(expression);
      const previous = canonical.get(key);
      if (previous !== undefined) return previous;
      canonical.set(key, expressions.length);
      expressions.push(expression);
      return expressions.length - 1;
    };
    const parseValue = (
      value: Node,
      node: Source,
      ctor: unknown,
      path: string,
    ): SurfaceExpression => {
      if (isValueReference(value)) {
        const result = admitReference(material, path, value);
        if (result !== undefined && !result.ok) fail(path, 'dependency', result.error.message);
        if (value.node !== null && !pristine(value.node))
          fail(path, 'unsafe-hook', 'reference uniform cache has custom hooks');
      }
      const current = isValueReference(value) ? referenceValue(material, value) : node.value;
      const type = valueType(current, isValueReference(value) ? value.uniformType : node.nodeType);
      if (
        type === undefined ||
        (type === 'bool' && ctor !== ConstNode) ||
        (type !== 'bool' && !numbers(current)?.every((v) => Number.isFinite(Math.fround(v))))
      )
        return fail(
          path,
          'value',
          'expected finite float/Vector/linear Color data of the declared type',
        );
      if (ctor === ConstNode)
        return {
          type,
          op: 'const',
          args: [],
          data: type === 'bool' ? String(current) : (numbers(current) ?? []),
        };
      else {
        if (inputs.length >= 64) return fail(path, 'budget', 'maximum 64 live inputs');
        const name = `threeInput${inputs.length}`;
        inputs.push({ name, type, node: value, path });
        return { type, op: 'input', args: [], data: name };
      }
    };
    const parseAttribute = (node: Source, path: string): SurfaceExpression => {
      const name = node._attributeName ?? node.attributeName;
      if (typeof name !== 'string' || !/^uv[1-7]?$/.test(name) || node.nodeType !== 'vec2')
        return fail(path, 'dependency', 'only explicit uv(0..7) attributes are available');
      return {
        type: 'vec2',
        op: 'uv',
        args: [],
        data: name === 'uv' ? '0' : name.slice(2),
      };
    };
    const parseTexture = (
      value: Node,
      node: Source,
      path: string,
      child: (name: string) => number,
    ): SurfaceExpression => {
      if (!textureValid(node.value))
        return fail(
          path,
          'dependency',
          'only RGBA unsigned-byte 2D image/data textures in declared sRGB/linear space and texture channels 0..3 are supported',
        );
      if (
        [
          'levelNode',
          'biasNode',
          'compareNode',
          'depthNode',
          'gradNode',
          'gatherNode',
          'offsetNode',
          'referenceNode',
        ].some((name) => node[name] != null) ||
        node.sampler !== true ||
        node.nodeType !== null
      )
        return fail(
          path,
          'dependency',
          'texture LOD, gradient, fetch, reference and attachment dependencies are unsupported',
        );
      if (textures.length >= 8) return fail(path, 'budget', 'maximum 8 expression textures');
      const args = node.uvNode == null ? [] : [child('uvNode')];
      if (args.length && expressions[args[0] ?? -1]?.type !== 'vec2')
        return fail(path, 'type', 'texture UV must be vec2');
      if (node.updateMatrix !== (args.length === 0))
        return fail(
          path,
          'dependency',
          'texture matrix mode must match explicit/default UV semantics',
        );
      const name = `threeTexture${textures.length}`;
      textures.push({
        name,
        node: value as TextureNode,
        path,
        contract: textureContract(node.value),
      });
      return { type: 'vec4', op: 'texture', args, data: name };
    };
    const parseSplit = (
      node: Source,
      path: string,
      child: (name: string) => number,
    ): SurfaceExpression => {
      const input = child('node'),
        components = node.components;
      if (
        !expressions[input]?.type.startsWith('vec') ||
        typeof components !== 'string' ||
        !/^[xyzw]{1,4}$/.test(components) ||
        [...components].some(
          (c) => 'xyzw'.indexOf(c) >= widths[expressions[input]?.type ?? 'float'],
        )
      )
        return fail(path, 'type', 'invalid component selection');
      return {
        type: (['float', 'vec2', 'vec3', 'vec4'] as const)[components.length - 1] ?? 'float',
        op: 'split',
        args: [input],
        data: components,
      };
    };
    const parseConstruct = (
      node: Source,
      ctor: unknown,
      path: string,
      depth: number,
      dependencies: Set<Node>,
      child: (name: string) => number,
    ): SurfaceExpression => {
      if (ctor === JoinNode && (!Array.isArray(node.nodes) || node.nodes.length > 4))
        return fail(path, 'budget', 'vector construction accepts at most four components');
      const args =
        ctor === ConvertNode
          ? [child('node')]
          : (Array.isArray(node.nodes) ? node.nodes : []).map((input, index) => {
              if (input instanceof Node) dependencies.add(input);
              return visit(input, `${path}.nodes[${index}]`, depth + 1);
            });
      const count = args.reduce(
        (sum, index) => sum + widths[expressions[index]?.type ?? 'float'],
        0,
      );
      const declared = ctor === ConvertNode ? node.convertTo : node.nodeType;
      const type =
        declared == null
          ? (['float', 'vec2', 'vec3', 'vec4'] as const)[count - 1]
          : declared === 'color'
            ? 'vec3'
            : declared;
      if (
        typeof type !== 'string' ||
        !['float', 'vec2', 'vec3', 'vec4'].includes(type) ||
        args.length === 0 ||
        args.some((i) => expressions[i]?.type === 'bool') ||
        (ctor === JoinNode &&
          count !== widths[type as ValueType] &&
          !(args.length === 1 && count === 1))
      )
        return fail(path, 'type', 'unsupported float/vector construction');
      return { type: type as ValueType, op: 'construct', args };
    };
    const parseConditional = (path: string, child: (name: string) => number): SurfaceExpression => {
      const args = [child('condNode'), child('ifNode'), child('elseNode')];
      if (
        expressions[args[0] ?? -1]?.type !== 'bool' ||
        expressions[args[1] ?? -1]?.type !== expressions[args[2] ?? -1]?.type
      )
        return fail(path, 'type', 'select requires scalar bool and equal branch types');
      return { type: expressions[args[1] ?? -1]?.type ?? 'float', op: 'select', args };
    };
    const parseOperation = (
      node: Source,
      ctor: unknown,
      path: string,
      child: (name: string) => number,
    ): SurfaceExpression => {
      const op = ctor === OperatorNode ? node.op : node.method;
      if (typeof op !== 'string' || !isOperation(op))
        return fail(path, 'unsupported-node', 'unsupported operation selector');
      const operator = operators.has(op);
      if ((ctor === OperatorNode) !== operator)
        return fail(
          path,
          'unsupported-node',
          'operation does not belong to the original node class',
        );
      const arity = unary.has(op) ? 1 : binary.has(op) ? 2 : 3;
      const args = ['aNode', 'bNode', 'cNode'].slice(0, arity).map(child);
      const types = args.map((i) => expressions[i]?.type ?? 'float');
      if (types.includes('bool')) return fail(path, 'type', 'numeric operands required');
      const width = Math.max(...types.map((t) => widths[t]));
      if (
        (['dot'].includes(op) && (types[0] !== types[1] || width === 1)) ||
        (['normalize', 'length'].includes(op) && width === 1)
      )
        return fail(path, 'type', 'incompatible operand widths');
      if (['<', '<=', '>', '>=', '==', '!='].includes(op) && width !== 1)
        return fail(path, 'type', 'vector comparisons require explicit semantics');
      const type = ['<', '<=', '>', '>=', '==', '!='].includes(op)
        ? 'bool'
        : ['dot', 'length'].includes(op)
          ? 'float'
          : ((['float', 'vec2', 'vec3', 'vec4'] as const)[width - 1] ?? 'float');
      return { type, op, args };
    };
    const validateDependencies = (
      value: Node,
      node: Source,
      ctor: unknown,
      path: string,
      dependencies: Set<Node>,
    ): void => {
      // Unknown node-bearing fields cannot hide unvisited renderer dependencies.
      for (const [name, item] of Object.entries(node)) {
        if (Array.isArray(item) && item.length > 256)
          fail(`${path}.${name}`, 'budget', 'dependency array exceeds the expression budget');
        const children = Array.isArray(item) ? item : [item];
        for (const dependency of children)
          if (
            dependency instanceof Node &&
            !dependencies.has(dependency) &&
            !(isValueReference(value) && name === 'node') &&
            !(
              name === 'groupNode' &&
              dependency === objectGroup &&
              (ctor === UniformNode || ctor === TextureNode)
            )
          )
            fail(`${path}.${name}`, 'dependency', 'undeclared dependency');
      }
    };
    const parseExpression = (
      value: Node,
      node: Source,
      ctor: unknown,
      path: string,
      depth: number,
      dependencies: Set<Node>,
      child: (name: string) => number,
    ): SurfaceExpression => {
      if (ctor === ConstNode || ctor === UniformNode || isValueReference(value))
        return parseValue(value, node, ctor, path);
      if (ctor === AttributeNode) return parseAttribute(node, path);
      if (ctor === TextureNode) return parseTexture(value, node, path, child);
      if (ctor === SplitNode) return parseSplit(node, path, child);
      if (ctor === JoinNode || ctor === ConvertNode)
        return parseConstruct(node, ctor, path, depth, dependencies, child);
      if (ctor === ConditionalNode) return parseConditional(path, child);
      return parseOperation(node, ctor, path, child);
    };
    const visit = (value: unknown, path: string, depth: number): number => {
      if (!(value instanceof Node)) return fail(path, 'type', 'expected an original r187 Node');
      if (active.has(value)) return fail(path, 'cycle', 'cyclic dependency');
      const previous = visited.get(value);
      if (previous !== undefined) return previous;
      if (depth > 64 || ++sourceNodes > 256)
        return fail(path, 'budget', 'maximum 64 depth / 256 expressions');
      const node = source(value),
        ctor = originalConstructors.get(Object.getPrototypeOf(value) as object);
      if (ctor === undefined) return fail(path, 'unsupported-node', 'unsupported node class');
      if (
        !pristine(value) ||
        value.updateBeforeType !== 'none' ||
        value.updateAfterType !== 'none' ||
        value.updateType !== (isValueReference(value) ? 'object' : 'none') ||
        node.precision != null
      )
        return fail(
          path,
          'unsafe-hook',
          'node methods, precision and update callbacks must be original',
        );
      active.add(value);
      const dependencies = new Set<Node>();
      const child = (name: string) => {
        const input = node[name];
        if (input instanceof Node) dependencies.add(input);
        return visit(input, `${path}.${name}`, depth + 1);
      };
      const expression = parseExpression(value, node, ctor, path, depth, dependencies, child);
      validateDependencies(value, node, ctor, path, dependencies);
      if (expressions.length >= 256) return fail(path, 'budget', 'maximum 256 expressions');
      const index = add(expression);
      visited.set(value, index);
      active.delete(value);
      return index;
    };
    for (const root of SURFACE_ROOTS) {
      const value = source(material)[root];
      if (value == null) continue;
      if (model === 'unlit' && ['roughnessNode', 'metalnessNode', 'emissiveNode'].includes(root))
        fail(root, 'unsupported-node', 'Basic has no lit surface inputs');
      const index = visit(value, root, 0),
        type = expressions[index]?.type;
      const expected =
        root === 'colorNode' ? ['vec3', 'vec4'] : root === 'emissiveNode' ? ['vec3'] : ['float'];
      if (!expected.includes(type ?? '')) fail(root, 'type', `expected ${expected.join(' or ')}`);
      roots[root] = index;
    }
    if (Object.keys(roots).length === 0) fail('material', 'type', 'recipe has no surface roots');
    const ordinaryTextures = ordinaryTextureMembership(material, roots);
    const graphKey = sha256(
      structuralJson({
        version: 'three-r187-surface/1',
        model,
        expressions,
        roots,
        textures: textures.map(({ contract }) => contract),
        ordinaryTextures,
      }),
    );
    return ok({
      model,
      expressions,
      roots,
      graphKey,
      inputs,
      ordinaryMaps: ordinaryTextures,
      uvSets: [
        ...new Set([
          ...expressions
            .filter((expression) => expression.op === 'uv')
            .map((expression) => Number(expression.data)),
          ...textures
            .filter(({ node }) => node.uvNode === null)
            .map(({ node }) => node.value.channel),
        ]),
      ].sort(),
      textures,
      parameters: [
        ...inputs.map(({ name, type }) => ({ name, type: wgslTypes[type] }) as MaterialParameter),
        ...textures.map(({ name }) => ({ name, type: 'texture' }) as const),
      ],
    });
  } catch (error) {
    if (error instanceof ThreeSurfaceError) return err(error);
    throw error;
  }
}

/** Explicit rebind is the only structural mutation boundary. Values stay caller-owned. */
export function bindThreeSurface(
  material: Material,
  recipe: ThreeSurfaceRecipe,
): Result<void, ThreeSurfaceError> {
  const normalized = normalizeThreeSurface(material);
  if (!normalized.ok) return normalized;
  if (
    recipe.version !== 'three-r187-surface/1' ||
    normalized.value.graphKey !== recipe.graphKey ||
    !/^forgeax-three-surface-[a-f0-9]{64}$/.test(recipe.programGuid)
  )
    return err(
      new ThreeSurfaceError(
        material,
        'material',
        'recipe-mismatch',
        'graph does not match the cooked recipe',
      ),
    );
  bindings.set(material, {
    recipe: Object.freeze({ ...recipe }),
    graph: normalized.value,
    roots: SURFACE_ROOTS.map((root) => source(material)[root]),
  });
  material.needsUpdate = true;
  return ok(undefined);
}
export function validateSurfaceBinding(material: Material): Result<void, ThreeSurfaceError> {
  const binding = bindingFor(material);
  if (binding === undefined) return ok(undefined);
  if (
    material.onBeforeCompile !== Material.prototype.onBeforeCompile ||
    material.onBeforeRender !== Material.prototype.onBeforeRender
  )
    return err(
      new ThreeSurfaceError(material, 'material', 'unsafe-hook', 'material callback changed'),
    );
  if (material.alphaHash || material.alphaToCoverage)
    return err(
      new ThreeSurfaceError(
        material,
        'alphaHash/alphaToCoverage',
        'unsupported-node',
        'expression coverage requires separate acceptance',
      ),
    );
  try {
    readSurfaceValues(material, binding);
    return ok(undefined);
  } catch (error) {
    if (error instanceof ThreeSurfaceError) return err(error);
    throw error;
  }
}
function readSurfaceValues(
  material: Material,
  binding: Binding,
): Record<string, number | readonly number[]> {
  if (ColorManagement.workingColorSpace !== LinearSRGBColorSpace)
    throw new ThreeSurfaceError(
      material,
      'colorSpace',
      'rebind-required',
      'working color space changed',
    );
  if (SURFACE_ROOTS.some((root, i) => source(material)[root] !== binding.roots[i]))
    throw new ThreeSurfaceError(material, 'material', 'rebind-required', 'surface roots changed');
  const membership = ordinaryTextureMembership(material, binding.graph.roots);
  if (
    membership.length !== binding.graph.ordinaryMaps.length ||
    membership.some((name, i) => name !== binding.graph.ordinaryMaps[i])
  )
    throw new ThreeSurfaceError(
      material,
      'material.maps',
      'rebind-required',
      'ordinary map membership changed',
    );
  const values: Record<string, number | readonly number[]> = {};
  for (const { name, type, node, path } of binding.graph.inputs) {
    const value = isValueReference(node) ? referenceValue(material, node) : source(node).value;
    if (
      valueType(value, type) !== type ||
      !numbers(value)?.every((v) => Number.isFinite(Math.fround(v)))
    )
      throw new ThreeSurfaceError(material, path, 'value', 'live input type/value changed');
    values[name] = typeof value === 'number' ? value : (numbers(value) ?? []);
  }
  for (const { node, path, contract } of binding.graph.textures)
    if (!textureValid(node.value) || textureContract(node.value) !== contract)
      throw new ThreeSurfaceError(
        material,
        path,
        'rebind-required',
        'texture class/space/channel/format changed',
      );
  return values;
}
export function threeSurfaceTextures(material: Material): readonly (readonly [string, Texture])[] {
  return (
    bindingFor(material)?.graph.textures.map(({ name, node }) => [name, node.value] as const) ?? []
  );
}
export function threeSurfaceRevisions(material: Material): readonly unknown[] {
  const binding = bindingFor(material);
  return binding === undefined
    ? []
    : [binding.recipe.programGuid, ...Object.values(readSurfaceValues(material, binding)).flat()];
}
export function projectThreeSurface(
  material: Material,
  projected: MaterialAsset,
  textures: Readonly<Record<string, unknown>> = {},
): MaterialAsset {
  const binding = bindingFor(material);
  if (binding === undefined) return projected;
  for (const { name, path } of binding.graph.textures)
    if (textures[name] === undefined)
      throw new ThreeSurfaceError(
        material,
        path,
        'dependency',
        'missing projected texture binding',
      );
  const output = {
    ...projected,
    [recipeSelection]: binding.recipe,
    passes: projected.passes?.map((pass) => ({
      ...pass,
      program: {
        ...pass.program,
        moduleSlots: {
          ...pass.program.moduleSlots,
          surface: `forgeax_three::surface_${binding.graph.graphKey}`,
        },
      },
    })),
    values: {
      ...projected.values,
      ...Object.fromEntries(binding.graph.textures.map(({ name }) => [name, textures[name]])),
      ...readSurfaceValues(material, binding),
    },
  } as SurfaceProjection;
  return output;
}

export function threeSurfaceUvSets(material: Material): readonly number[] {
  return bindingFor(material)?.graph.uvSets ?? [];
}
/** Missing authored graph attributes fail before native material/resource publication. */
export function validateThreeSurfaceGeometry(material: Material, geometry: BufferGeometry): void {
  for (const set of threeSurfaceUvSets(material)) {
    const name = set === 0 ? 'uv' : `uv${set}`;
    const attribute = geometry.getAttribute(name);
    if (
      attribute === undefined ||
      attribute.itemSize !== 2 ||
      attribute.count !== geometry.getAttribute('position')?.count
    )
      throw new ThreeSurfaceError(
        material,
        `geometry.${name}`,
        'dependency',
        'authored UV requires a matching two-component geometry stream',
      );
  }
}
