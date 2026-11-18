import * as THREE from '@forgeax/engine/three';
import * as TSL from '@forgeax/engine/three/tsl';
import { expect, it } from 'vitest';

it('preserves constructor/factory identity and literal node types through public entries', () => {
  expect(TSL.reference).toBe(THREE.TSL.reference);
  expect(TSL.userData).toBe(THREE.TSL.userData);
  const parameters = { tint: new THREE.Color('red') },
    material = new THREE.MeshBasicNodeMaterial();
  const reference = TSL.reference('tint', 'color', parameters),
    userData = TSL.userData('tint', 'color', parameters);
  const base = new THREE.ReferenceBaseNode('tint', 'color', parameters);
  const direct = new THREE.ReferenceNode('tint', 'color', parameters);
  for (const node of [reference, userData, base, direct]) {
    material.colorNode = node;
    const typed: THREE.Node<'color'> = node;
    void typed;
  }
  expect(reference).toBeInstanceOf(THREE.ReferenceNode);
  expect(userData).toBeInstanceOf(THREE.UserDataNode);
  const named = userData.setGroup(new THREE.UniformGroupNode('material')).setName('tint');
  expect(named.userData).toBe(parameters);
  expect(named).toBe(userData);
  // Retain the legacy object-first generic spelling on ReferenceBaseNode.
  const legacy: THREE.ReferenceBaseNode<typeof parameters> = new THREE.ReferenceBaseNode<
    typeof parameters
  >('tint', 'color', parameters);
  expect(legacy.object).toBe(parameters);
  const materialRef = THREE.TSL.materialReference('tint', 'color', material).setName('tint');
  expect(materialRef.material).toBe(material);
  class Parameters {
    tint = new THREE.Color('red');
  }
  const classStore = new Parameters();
  expect(TSL.userData('tint', 'color', classStore).userData).toBe(classStore);
  const implicit = TSL.reference('tint', 'color');
  expect(implicit.object).toBeNull();
  material.dispose();
});
function negativeTypes() {
  // @ts-expect-error The source type argument is required.
  TSL.reference('tint');
  // @ts-expect-error It is a string type, not a shader node.
  TSL.userData('tint', TSL.uniform(1));
  const reference = new THREE.UserDataNode('tint', 'color');
  // @ts-expect-error Color references are not scalar nodes.
  const scalar: THREE.Node<'float'> = reference;
  void scalar;
  const base = new THREE.ReferenceBaseNode('tint', 'color');
  // The base inherits ContextNode naming; it does not promise a named-reference result.
  const context: THREE.Node<'color'> = base.setName('context');
  void context;
}
void negativeTypes;
