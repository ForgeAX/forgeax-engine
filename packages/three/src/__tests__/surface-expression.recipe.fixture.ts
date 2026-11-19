import * as Engine from '@forgeax/engine/three';
import * as Nodes from '@forgeax/engine/three/tsl';

/** Host-neutral consumer recipe shared by the producer and player. */
export function surfaceExpressionExample(
  kind: 'standard' | 'unlit' | 'roughness',
  THREE = Engine,
  nodes = Nodes,
  rebound = false,
) {
  if (!['standard', 'unlit', 'roughness'].includes(kind))
    throw new Error('Unknown surface expression fixture kind');
  const { float, mix, reference, texture, uniform, uv, vec3, vec4 } = nodes;
  const material =
    kind === 'standard' ? new THREE.MeshStandardNodeMaterial() : new THREE.MeshBasicNodeMaterial();
  const amount = uniform(0.25);
  const store = { tint: new THREE.Color(0.7, 0.25, 0.12), alpha: 0.85, threshold: 0.15 };
  const image = new THREE.DataTexture(
    new Uint8Array([128, 224, 96, 255, 224, 64, 128, 192, 32, 192, 224, 255, 224, 192, 64, 255]),
    2,
    2,
  );
  image.colorSpace = THREE.SRGBColorSpace;
  image.needsUpdate = true;
  image.magFilter = THREE.LinearFilter;
  image.minFilter = THREE.LinearFilter;
  const offset = uniform(new THREE.Vector2(0.1, 0.1));
  const sampled = texture(image, uv().mul(0.8).add(offset));
  material.colorNode = sampled.mul(vec4(reference('tint', 'color', store), float(1)));
  material.opacityNode = reference('alpha', 'float', store).mul(amount.mul(0.2).add(0.8));
  material.alphaTestNode = reference('threshold', 'float', store);
  material.transparent = true;
  const roughness = mix(float(0.12), float(0.9), amount.mul(0.8).add(0.1));
  if (kind === 'roughness') {
    material.colorNode = vec3(roughness);
    material.opacityNode = null;
    material.alphaTestNode = null;
    material.transparent = false;
  }
  if (material instanceof THREE.MeshStandardNodeMaterial) {
    material.shadowSide = THREE.DoubleSide;
    material.roughnessNode = roughness;
    material.metalnessNode = amount.mul(0.25);
    material.emissiveNode = vec3(0.03, 0.06, 0.01).mul(amount);
  }
  if (rebound) material.colorNode = vec3(0.65, 0.1, 0.8).mul(amount.mul(0.5).add(0.5));
  return { material, amount, offset, store, sampled, image };
}
