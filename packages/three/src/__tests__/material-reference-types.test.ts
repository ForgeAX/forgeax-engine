import * as THREE from '@forgeax/engine/three';
import * as TSL from '@forgeax/engine/three/tsl';
import { expect, it } from 'vitest';

it('shares the original reference factory across public entries and retains inferred leaf types', () => {
  expect(TSL.materialReference).toBe(THREE.TSL.materialReference);
  const material = new THREE.MeshStandardNodeMaterial();
  const color = TSL.materialReference('tint', 'color', material);
  const scalar = new THREE.MaterialReferenceNode('alpha', 'float');
  material.colorNode = color;
  material.opacityNode = scalar;
  const typedColor: THREE.Node<'color'> = color;
  const typedScalar: THREE.Node<'float'> = scalar;
  expect(color).toBeInstanceOf(THREE.MaterialReferenceNode);
  expect(color.material).toBe(material);
  expect(scalar.material).toBeNull();
  expect(color.setGroup(new THREE.UniformGroupNode('material')).setName('tint')).toBe(color);
  void typedColor;
  void typedScalar;
  material.dispose();
});

function negativeReferenceTypes() {
  // @ts-expect-error r187 requires a string type argument.
  TSL.materialReference('tint');
  // @ts-expect-error A shader node is not the actual r187 type argument.
  TSL.materialReference('tint', TSL.uniform(1));
  const reference = new THREE.MaterialReferenceNode('tint', 'color');
  // @ts-expect-error Explicit targets are materials.
  reference.material = new THREE.Mesh();
  // @ts-expect-error Color references do not become scalar nodes.
  const scalar: THREE.Node<'float'> = reference;
  void scalar;
}
void negativeReferenceTypes;
