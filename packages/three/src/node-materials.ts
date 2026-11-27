import { ok, type Result } from '@forgeax/engine-types';
import LineBasicNodeMaterial from 'three/src/materials/nodes/LineBasicNodeMaterial.js';
import LineDashedNodeMaterial from 'three/src/materials/nodes/LineDashedNodeMaterial.js';
import MeshBasicNodeMaterial from 'three/src/materials/nodes/MeshBasicNodeMaterial.js';
import MeshLambertNodeMaterial from 'three/src/materials/nodes/MeshLambertNodeMaterial.js';
import MeshMatcapNodeMaterial from 'three/src/materials/nodes/MeshMatcapNodeMaterial.js';
import MeshNormalNodeMaterial from 'three/src/materials/nodes/MeshNormalNodeMaterial.js';
import MeshPhysicalNodeMaterial from 'three/src/materials/nodes/MeshPhysicalNodeMaterial.js';
import MeshStandardNodeMaterial from 'three/src/materials/nodes/MeshStandardNodeMaterial.js';
import PointsNodeMaterial from 'three/src/materials/nodes/PointsNodeMaterial.js';
import SpriteNodeMaterial from 'three/src/materials/nodes/SpriteNodeMaterial.js';
import { Material } from 'three/src/Three.Core.js';
import { unsupported } from './errors';
import { admitSurfaceInput, type InputField, SURFACE_INPUTS } from './node-inputs';
import { instanceShaderOverride, nodeDefinition } from './node-material-instance';
import { boundSurfaceRoot, SURFACE_ROOTS, validateSurfaceBinding } from './node-surface';
import { hasSourceField } from './source-fields';

export { default as NodeMaterial } from 'three/src/materials/nodes/NodeMaterial.js';
export {
  LineBasicNodeMaterial,
  LineDashedNodeMaterial,
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  MeshMatcapNodeMaterial,
  MeshNormalNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  PointsNodeMaterial,
  SpriteNodeMaterial,
};

// Fixed r187 source inputs; admission reads these fields without enumerating every frame.
export const NODE_MATERIAL_INPUTS = [
  'lightsNode',
  'envNode',
  'aoNode',
  'colorNode',
  'normalNode',
  'opacityNode',
  'backdropNode',
  'backdropAlphaNode',
  'alphaTestNode',
  'maskNode',
  'maskShadowNode',
  'positionNode',
  'geometryNode',
  'depthNode',
  'receivedShadowPositionNode',
  'castShadowPositionNode',
  'receivedShadowNode',
  'castShadowNode',
  'outputNode',
  'mrtNode',
  'fragmentNode',
  'vertexNode',
  'contextNode',
  'emissiveNode',
  'metalnessNode',
  'roughnessNode',
  'clearcoatNode',
  'clearcoatRoughnessNode',
  'diffuseRoughnessNode',
  'clearcoatNormalNode',
  'sheenNode',
  'sheenRoughnessNode',
  'iridescenceNode',
  'iridescenceIORNode',
  'iridescenceThicknessNode',
  'specularIntensityNode',
  'specularColorNode',
  'iorNode',
  'transmissionNode',
  'thicknessNode',
  'attenuationDistanceNode',
  'attenuationColorNode',
  'dispersionNode',
  'retroreflectivityNode',
  'anisotropyNode',
  'offsetNode',
  'dashScaleNode',
  'dashSizeNode',
  'gapSizeNode',
  'rotationNode',
  'scaleNode',
  'sizeNode',
] as const;

type Hook = readonly [string, unknown];
function sourceHooks(prototype: object): readonly Hook[] {
  const hooks = new Map<string, unknown>();
  let current: object | null = prototype;
  while (current !== null && current !== Material.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (key !== 'constructor' && typeof descriptor?.value === 'function' && !hooks.has(key))
        hooks.set(key, descriptor.value);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...hooks];
}
function model(prototype: object, count: number, lit?: boolean, extra: readonly string[] = []) {
  return {
    hooks: sourceHooks(prototype),
    flag: `is${String(Reflect.get(prototype.constructor, 'type'))}`,
    requiredInputs: new Set<string>([...NODE_MATERIAL_INPUTS.slice(0, count), ...extra]),
    lit,
  };
}
const models = new Map<object, ReturnType<typeof model>>([
  [MeshBasicNodeMaterial, model(MeshBasicNodeMaterial.prototype, 23)],
  [MeshStandardNodeMaterial, model(MeshStandardNodeMaterial.prototype, 26, true)],
  [MeshPhysicalNodeMaterial, model(MeshPhysicalNodeMaterial.prototype, 45, true)],
  [MeshLambertNodeMaterial, model(MeshLambertNodeMaterial.prototype, 24, true)],
  [MeshNormalNodeMaterial, model(MeshNormalNodeMaterial.prototype, 23, false)],
  [MeshMatcapNodeMaterial, model(MeshMatcapNodeMaterial.prototype, 23, false)],
  [LineBasicNodeMaterial, model(LineBasicNodeMaterial.prototype, 23, false)],
  [
    LineDashedNodeMaterial,
    model(LineDashedNodeMaterial.prototype, 23, false, [
      'offsetNode',
      'dashScaleNode',
      'dashSizeNode',
      'gapSizeNode',
    ]),
  ],
  [
    SpriteNodeMaterial,
    model(SpriteNodeMaterial.prototype, 23, false, ['rotationNode', 'scaleNode']),
  ],
  [
    PointsNodeMaterial,
    model(PointsNodeMaterial.prototype, 23, false, ['rotationNode', 'scaleNode', 'sizeNode']),
  ],
]);

/** Original Basic/Standard node models backed entirely by ordinary material fields. */
export function plainNodeMaterial(material: Material): boolean {
  const prototype = Object.getPrototypeOf(material);
  const source = material as unknown as Record<string, unknown>;
  if (
    prototype !== MeshBasicNodeMaterial.prototype &&
    prototype !== MeshStandardNodeMaterial.prototype
  )
    return false;
  return NODE_MATERIAL_INPUTS.every(
    (key) => source[key] === null || (source[key] === undefined && !hasSourceField(source, key)),
  );
}

/** A resident node material invalidates admission when its source hooks are replaced. */
export function watchNodeMaterialHooks(
  material: Material,
  watch: (key: string) => boolean,
): boolean {
  return models.get(material.constructor)?.hooks.every(([key]) => watch(key)) ?? false;
}

/** Ordinary leaves keep native projection; expressions require an explicit cooked binding. */
export function admitNodeMaterial(
  material: Material,
  preparingSurface = false,
): Result<void, Error> {
  const definition = nodeDefinition(material);
  const model = models.get(definition.constructor);
  if (model === undefined)
    return unsupported('NodeMaterial subclass requires native graph conversion', material.uuid);
  const admitted = admitDefinition(material, definition, model);
  if (!admitted.ok) return admitted;
  const binding = preparingSurface ? acceptedMaterial : validateSurfaceBinding(material);
  if (!binding.ok) return binding;
  const source = material as unknown as Record<string, unknown>;
  for (const field of NODE_MATERIAL_INPUTS) {
    const value = source[field];
    if (
      (preparingSurface && SURFACE_ROOTS.some((root) => root === field)) ||
      boundSurfaceRoot(material, field)
    )
      continue;
    if (
      field in SURFACE_INPUTS &&
      model.requiredInputs.has(field) &&
      value !== null &&
      value !== undefined
    ) {
      const admitted = admitSurfaceInput(material, field as InputField, value);
      if (!admitted.ok) return admitted;
      continue;
    }
    if (
      value !== null &&
      (value !== undefined || model.requiredInputs.has(field) || hasSourceField(source, field))
    )
      return unsupported(`NodeMaterial.${field} requires native graph conversion`, material.uuid);
  }
  return acceptedMaterial;
}

const acceptedMaterial = ok(undefined);
function admitDefinition(
  material: Material,
  definition: Material,
  contract: ReturnType<typeof model>,
): Result<void, Error> {
  const source = material as unknown as Record<string, unknown>;
  if (definition !== material) {
    const override = instanceShaderOverride(material);
    if (override !== undefined)
      return unsupported(`NodeMaterialInstance.${override} override`, material.uuid);
    if (
      definition.constructor === MeshPhysicalNodeMaterial ||
      source.isMeshPhysicalMaterial === true
    )
      return unsupported('NodeMaterialInstance Physical prototype accessors', material.uuid);
    if (source[contract.flag] !== true)
      return unsupported('NodeMaterialInstance changed model definition', material.uuid);
  }
  const hooks = definition as unknown as Record<string, unknown>;
  for (const [name, implementation] of contract.hooks)
    if (hooks[name] !== implementation)
      return unsupported(
        `NodeMaterial.${name} override requires native graph conversion`,
        material.uuid,
      );
  if (
    contract.lit !== undefined &&
    (source.lights !== contract.lit || hooks.lights !== contract.lit)
  )
    return unsupported(
      `NodeMaterial.lights=${String(source.lights)} requires a native lighting variant`,
      material.uuid,
    );
  return acceptedMaterial;
}
