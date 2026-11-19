import ConstNode from 'three/src/nodes/core/ConstNode.js';
import type Node from 'three/src/nodes/core/Node.js';
import SplitNode from 'three/src/nodes/utils/SplitNode.js';
import {
  Color,
  ColorManagement,
  DataTexture,
  Float32BufferAttribute,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
} from 'three/src/Three.Core.js';
import { describe, expect, it } from 'vitest';
import { lowerThreeSurface } from '../build/surface';
import { materialTextures, projectMaterial, validateMaterial } from '../material';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from '../node-materials';
import {
  bindThreeSurface,
  normalizeThreeSurface,
  ThreeSurfaceError,
  type ThreeSurfaceRecipe,
  threeSurfaceRevisions,
  validateSurfaceBinding,
  validateThreeSurfaceGeometry,
} from '../node-surface';
import { add, Fn, float, mix, pass, reference, texture, uniform, uv, vec3 } from '../tsl';

function roughness() {
  const material = new MeshStandardNodeMaterial();
  const value = uniform(0.25);
  material.roughnessNode = mix(float(0.1), value.mul(0.8).add(0.1), float(0.6));
  return { material, value };
}
function recipe(material: MeshStandardNodeMaterial | MeshBasicNodeMaterial): ThreeSurfaceRecipe {
  return {
    version: 'three-r187-surface/1',
    graphKey: normalizeThreeSurface(material).unwrap().graphKey,
    programGuid: `forgeax-three-surface-${'a'.repeat(64)}`,
  };
}
describe('r187 surface expression admission and live bindings', () => {
  it('preserves the published v1 target-map Surface graph identity', () => {
    const material = new MeshBasicNodeMaterial({ map: new DataTexture() });
    material.alphaTestNode = uniform(0).mul(0.5).add(0.1);
    expect(normalizeThreeSurface(material).unwrap().graphKey).toBe(
      '28decced2e8eb2129576dc018a20d2e712b577caaf9ce6722e530131e53f4573',
    );
  });
  it('normalizes arithmetic/mix once, keeps uniform values out of structural identity', () => {
    const { material, value } = roughness();
    const first = normalizeThreeSurface(material).unwrap();
    expect(first.expressions.map((e) => e.op)).toContain('mix');
    const wgsl = lowerThreeSurface(first, 'test::roughness');
    expect(wgsl).toContain('fn evaluate_surface(input: SurfaceInput) -> SurfaceData');
    expect(wgsl).toContain('surface.roughness =');
    value.value = 0.75;
    expect(normalizeThreeSurface(material).unwrap().graphKey).toBe(first.graphKey);
    material.roughnessNode = value.mul(0.7);
    expect(normalizeThreeSurface(material).unwrap().graphKey).not.toBe(first.graphKey);
  });
  it('requires explicit recipe binding, observes values, and rejects root replacement', () => {
    const { material, value } = roughness();
    expect(validateMaterial(material).ok).toBe(false);
    bindThreeSurface(material, recipe(material)).unwrap();
    expect(validateMaterial(material).ok).toBe(true);
    const borrowed = Object.assign(Object.create(material) as typeof material, {
      depthWrite: false,
    });
    expect(validateMaterial(borrowed).ok).toBe(true);
    expect(threeSurfaceRevisions(borrowed)).toEqual(threeSurfaceRevisions(material));
    const first = threeSurfaceRevisions(material);
    value.value = 0.7;
    expect(threeSurfaceRevisions(material)).not.toEqual(first);
    expect(validateSurfaceBinding(material).ok).toBe(true);
    material.roughnessNode = value.add(0.1);
    const changed = validateSurfaceBinding(material);
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.detail.reason).toBe('rebind-required');
    // Rebinding admits the new graph, without requiring an intermediate unbind.
    bindThreeSurface(material, recipe(material)).unwrap();
  });
  it('shares original node identities and separates constants from dynamic parameters', () => {
    const material = new MeshStandardNodeMaterial(),
      shared = uniform(0.5);
    material.roughnessNode = shared.mul(shared).add(0.1);
    const graph = normalizeThreeSurface(material).unwrap();
    expect(graph.inputs).toHaveLength(1);
    expect(graph.expressions.filter((e) => e.op === 'input')).toHaveLength(1);
    shared.value = Number.NaN;
    expect(normalizeThreeSurface(material).ok).toBe(false);
  });
  it('has host-neutral identity regardless of upstream constant object interning', () => {
    const shared = new ConstNode(0.5, 'float' as const);
    const left = new MeshBasicNodeMaterial();
    left.colorNode = vec3(shared, shared, shared);
    const right = new MeshBasicNodeMaterial();
    right.colorNode = vec3(
      new ConstNode(0.5, 'float' as const),
      new ConstNode(0.5, 'float' as const),
      new ConstNode(0.5, 'float' as const),
    );
    expect(normalizeThreeSurface(left).unwrap().graphKey).toBe(
      normalizeThreeSurface(right).unwrap().graphKey,
    );
  });
  it('bounds authored dependencies even when pure expressions canonicalize to a small DAG', () => {
    const expand = (depth: number): Node<'float'> =>
      depth === 0
        ? new ConstNode(0.5, 'float' as const)
        : add(expand(depth - 1), expand(depth - 1));
    const material = new MeshStandardNodeMaterial();
    material.roughnessNode = expand(8);
    const result = normalizeThreeSurface(material);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.reason).toBe('budget');
  });
  it('preserves default maps while replacing authored roots and uses fixed texture slots', () => {
    const material = new MeshStandardNodeMaterial();
    const color = new DataTexture(new Uint8Array([128, 64, 32, 255]), 1, 1);
    color.colorSpace = SRGBColorSpace;
    const ignored = new DataTexture(new Uint8Array(4), 1, 1);
    material.map = ignored;
    material.roughnessMap = ignored;
    material.colorNode = texture(color, uv().mul(0.5)).mul(vec3(0.7, 0.8, 0.9));
    bindThreeSurface(material, recipe(material)).unwrap();
    const textures = materialTextures(validateMaterial(material).unwrap());
    expect(textures).toContainEqual(['roughnessTexture', ignored]);
    expect(textures).toContainEqual(['threeTexture0', color]);
    expect(textures.some(([name]) => name === 'baseColorTexture')).toBe(false);
    const projected = projectMaterial(validateMaterial(material).unwrap(), {
      threeTexture0: { texture: 'test-image' },
    }).unwrap();
    expect(projected.values?.baseColor).toEqual([1, 1, 1, 1]);
    expect(projected.values?.threeTexture0).toEqual({ texture: 'test-image' });
    expect(
      projected.passes?.every(
        (pass) =>
          pass.program.moduleSlots?.surface ===
          `forgeax_three::surface_${normalizeThreeSurface(material).unwrap().graphKey}`,
      ),
    ).toBe(true);
    const missing = projectMaterial(validateMaterial(material).unwrap(), {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBeInstanceOf(ThreeSurfaceError);
    color.colorSpace = '';
    const changed = validateSurfaceBinding(material);
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.detail.reason).toBe('rebind-required');
  });
  it('reads direct references from their current source store and enforces types', () => {
    const material = new MeshStandardNodeMaterial(),
      store = { tint: new Color(0.2, 0.3, 0.4) };
    material.colorNode = reference('tint', 'color', store).mul(0.5);
    bindThreeSurface(material, recipe(material)).unwrap();
    store.tint = new Color(0.8, 0.7, 0.6);
    expect(threeSurfaceRevisions(material)).toContain(0.8);
    Object.assign(store, { tint: new Vector3(0.1, 0.2, 0.3) });
    expect(validateSurfaceBinding(material).ok).toBe(true);
    Object.assign(store, { tint: 0.5 });
    expect(validateSurfaceBinding(material).ok).toBe(false);
  });
  it('maps Basic to an explicitly emission-only surface', () => {
    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec3(0.1, 0.2, 0.3).mul(0.7);
    expect(lowerThreeSurface(normalizeThreeSurface(material).unwrap(), 'test::basic')).toContain(
      'surfaceEmissionOnly',
    );
    bindThreeSurface(material, recipe(material)).unwrap();
    expect(projectMaterial(validateMaterial(material).unwrap(), {}).unwrap().values?.specular).toBe(
      0,
    );
  });
  it('replaces ordinary scalar and emissive values before native material validation', () => {
    const material = new MeshStandardNodeMaterial();
    material.roughnessNode = uniform(2);
    material.metalnessNode = uniform(-1);
    material.emissiveNode = vec3(0.2, 0.1, 0);
    material.opacityNode = uniform(0.5);
    material.alphaTestNode = uniform(0.2);
    material.roughness = material.metalness = material.opacity = material.alphaTest = Number.NaN;
    material.emissive.setRGB(Number.NaN, 0, 0);
    bindThreeSurface(material, recipe(material)).unwrap();
    const projected = projectMaterial(validateMaterial(material).unwrap(), {}).unwrap();
    expect(projected.values).toMatchObject({ roughness: 1, metallic: 0, emissive: [0, 0, 0] });
    expect(threeSurfaceRevisions(material)).toContain(2);
    expect(threeSurfaceRevisions(material)).toContain(-1);
  });
  it('returns typed source paths for cycles, budgets, callback and screen/pass boundaries', () => {
    const material = new MeshStandardNodeMaterial();
    const cycle = uniform(0.5).add(0.1);
    Object.assign(cycle, { aNode: cycle });
    material.roughnessNode = cycle;
    let result = normalizeThreeSurface(material);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.detail).toMatchObject({ reason: 'cycle', path: 'roughnessNode.aNode' });
    let deep = uniform(0.5).add(0.1);
    for (let i = 0; i < 70; i++) deep = deep.add(0.1);
    material.roughnessNode = deep;
    result = normalizeThreeSurface(material);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.reason).toBe('budget');
    material.roughnessNode = uniform(0.5).onFrameUpdate(() => 0.7);
    result = normalizeThreeSurface(material);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.reason).toBe('unsafe-hook');
    material.roughnessNode = Fn(() => float(0.3))();
    expect(normalizeThreeSurface(material).ok).toBe(false);
    material.roughnessNode = pass(new Scene(), new PerspectiveCamera()).getTextureNode().r;
    result = normalizeThreeSurface(material);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ThreeSurfaceError);
      expect(result.error.detail.path).toContain('roughnessNode');
    }
  });
  it('rejects unsafe material hooks, normal spaces and hidden dependencies before publication', () => {
    const { material } = roughness();
    material.normalNode = vec3(0, 0, 1);
    expect(normalizeThreeSurface(material).ok).toBe(false);
    material.normalNode = null;
    Object.assign(material.roughnessNode as object, {
      hidden: pass(new Scene(), new PerspectiveCamera()),
    });
    expect(normalizeThreeSurface(material).ok).toBe(false);
    const other = roughness().material;
    Object.assign(other, { setup: () => {} });
    expect(normalizeThreeSurface(other).ok).toBe(false);
  });
  it('rejects a node constructor accessor without evaluating its callback', () => {
    const { material } = roughness();
    const input = material.roughnessNode;
    if (input === null) throw new Error('missing graph root');
    let called = false;
    const original = Object.getPrototypeOf(input).constructor;
    Object.defineProperty(input, 'constructor', {
      get() {
        called = true;
        return original;
      },
    });
    expect(normalizeThreeSurface(material).ok).toBe(false);
    expect(called).toBe(false);
  });
  it('rejects scalar component selection before WGSL cooking', () => {
    const material = new MeshStandardNodeMaterial();
    material.roughnessNode = new SplitNode(float(0.5), 'x');
    const result = normalizeThreeSurface(material);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.reason).toBe('type');
  });
  it('rejects operation selector objects without invoking their coercion callbacks', () => {
    const { material } = roughness();
    let called = false;
    const input = uniform(0.5).add(0.1);
    Object.assign(input, {
      op: {
        toString: () => {
          called = true;
          return '+';
        },
      },
    });
    material.roughnessNode = input;
    expect(normalizeThreeSurface(material).ok).toBe(false);
    expect(called).toBe(false);
  });
  it('rejects a texture channel outside the owning r187 texture projection contract', () => {
    const material = new MeshBasicNodeMaterial();
    const image = new DataTexture(new Uint8Array(4), 1, 1);
    image.channel = 4;
    material.colorNode = texture(image, uv());
    const result = normalizeThreeSurface(material);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.detail).toMatchObject({ path: 'colorNode', reason: 'dependency' });
    image.dispose();
  });
  it('rejects missing authored UV streams and ordinary map structure changes', () => {
    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec3(uv(2), float(0.5));
    bindThreeSurface(material, recipe(material)).unwrap();
    const geometry = new PlaneGeometry();
    expect(() => validateThreeSurfaceGeometry(material, geometry)).toThrow('geometry.uv2');
    geometry.setAttribute(
      'uv2',
      new Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 2), 2),
    );
    expect(() => validateThreeSurfaceGeometry(material, geometry)).not.toThrow();
    material.map = new DataTexture(); // replaced by colorNode, so it is not a structural change
    expect(validateSurfaceBinding(material).ok).toBe(true);
    const standard = roughness().material;
    bindThreeSurface(standard, recipe(standard)).unwrap();
    standard.normalMap = new DataTexture();
    const result = validateSurfaceBinding(standard);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.reason).toBe('rebind-required');
    geometry.dispose();
  });
  it('refuses an unsupported working color space without replacing the accepted binding', () => {
    const { material } = roughness();
    bindThreeSurface(material, recipe(material)).unwrap();
    const original = ColorManagement.workingColorSpace;
    try {
      Reflect.set(ColorManagement, 'workingColorSpace', 'display-p3-linear');
      const result = normalizeThreeSurface(material);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.detail.path).toBe('colorSpace');
      expect(validateSurfaceBinding(material).ok).toBe(false);
    } finally {
      ColorManagement.workingColorSpace = original;
    }
    expect(validateSurfaceBinding(material).ok).toBe(true);
  });
});
