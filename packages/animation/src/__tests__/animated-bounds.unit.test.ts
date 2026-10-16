// biome-ignore-all lint/style/noNonNullAssertion: valid enclosure fixtures must fail if any expected bound or lane is absent.
import { describe, expect, it } from 'vitest';
import { type AnimatedBoundsNode, deriveConservativeAnimatedBounds } from '../animated-bounds';

const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const node = (parent: number | null = null): AnimatedBoundsNode => ({
  parent,
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
});
const mesh = { node: 1, positions: [1, 0, 0], joints: [0, 0, 0, 0], weights: [1, 0, 0, 0] };
const contains = (bounds: Float32Array, p: number[]) => {
  for (let axis = 0; axis < 3; axis++) {
    expect(p[axis]!).toBeGreaterThanOrEqual(bounds[axis]!);
    expect(p[axis]!).toBeLessThanOrEqual(bounds[axis + 3]!);
  }
};
describe('conservative imported animation bounds', () => {
  it('contains between-key rotation extrema, negative scale, translation and clip blending', () => {
    const bounds = deriveConservativeAnimatedBounds({
      nodes: [node(), node(0), node(0)],
      jointNodes: [2],
      inverseBindMatrices: identity,
      meshes: [mesh],
      channels: [
        {
          node: 2,
          property: 'rotation',
          values: [0, 0, 0, 1, 0, 0, 1, 0],
          interpolation: 'LINEAR',
        },
        { node: 2, property: 'translation', values: [0, 0, 0, 2, 3, -1], interpolation: 'LINEAR' },
        { node: 2, property: 'scale', values: [1, 1, 1, -2, 3, 1], interpolation: 'LINEAR' },
      ],
    });
    expect(bounds).toBeDefined();
    if (!bounds) return;
    for (let step = 0; step <= 1000; step++) {
      const t = step / 1000,
        scale = 1 - 3 * t,
        angle = Math.PI * t;
      contains(bounds, [2 * t + Math.cos(angle) * scale, 3 * t + Math.sin(angle) * scale, -t]);
    }
  });
  it('cancels shared animated ancestors instead of inflating world-scale motion', () => {
    const bounds = deriveConservativeAnimatedBounds({
      nodes: [node(), node(0), node(0)],
      jointNodes: [2],
      inverseBindMatrices: identity,
      meshes: [mesh],
      channels: [
        {
          node: 0,
          property: 'translation',
          values: [0, 0, 0, 1000000, 0, 0],
          interpolation: 'LINEAR',
        },
        {
          node: 0,
          property: 'scale',
          values: [1, 1, 1, 1000, 1000, 1000],
          interpolation: 'LINEAR',
        },
      ],
    })!;
    contains(bounds, [1, 0, 0]);
    expect(bounds[3]! - bounds[0]!).toBeLessThan(0.001);
  });
  it('covers animated inverse mesh transforms and every mesh instance', () => {
    const bounds = deriveConservativeAnimatedBounds({
      nodes: [node(), node(0), node(0), { ...node(0), translation: [-4, 0, 0] }],
      jointNodes: [2],
      inverseBindMatrices: identity,
      meshes: [mesh, { ...mesh, node: 3 }],
      channels: [
        { node: 1, property: 'translation', values: [0, 0, 0, 2, 0, 0], interpolation: 'STEP' },
        { node: 1, property: 'scale', values: [1, 1, 1, 0.5, 1, 1], interpolation: 'LINEAR' },
      ],
    })!;
    contains(bounds, [-2, 0, 0]);
    contains(bounds, [5, 0, 0]);
  });
  it('keeps a deep animated rotation chain bounded by its geometric radius', () => {
    const nodes = [
      node(),
      node(0),
      ...Array.from({ length: 60 }, (_, i) => node(i === 0 ? 0 : i + 1)),
    ];
    const bounds = deriveConservativeAnimatedBounds({
      nodes,
      jointNodes: [61],
      inverseBindMatrices: identity,
      meshes: [mesh],
      channels: nodes.slice(2).map((_, i) => ({
        node: i + 2,
        property: 'rotation' as const,
        values: [0, 0, 0, 1, 0, 0, 1, 0],
        interpolation: 'LINEAR' as const,
      })),
    })!;
    contains(bounds, [0, 1, 0]);
    expect(Math.max(...bounds.map(Math.abs))).toBeLessThan(1.001);
  });
  it('encloses signed morph deltas before the inverse-bind transform', () => {
    const ibm = new Float32Array(identity);
    ibm[0] = 2;
    ibm[12] = -3;
    const bounds = deriveConservativeAnimatedBounds({
      nodes: [node(), node(0), node(0)],
      jointNodes: [2],
      inverseBindMatrices: ibm,
      meshes: [{ ...mesh, morphExtent: [3, 2, 1] }],
      channels: [],
    })!;
    contains(bounds, [-7, -2, -1]);
    contains(bounds, [5, 2, 1]);
  });
  it('refuses singular, malformed and incomplete producer facts', () => {
    const input = {
      nodes: [node(), node(0), node(0)],
      jointNodes: [2],
      inverseBindMatrices: identity,
      meshes: [mesh],
      channels: [],
    };
    expect(
      deriveConservativeAnimatedBounds({
        ...input,
        channels: [
          { node: 1, property: 'scale', values: [1, 1, 1, -1, 1, 1], interpolation: 'LINEAR' },
        ],
      }),
    ).toBeUndefined();
    expect(
      deriveConservativeAnimatedBounds({ ...input, meshes: [{ ...mesh, weights: [0, 0, 0, 0] }] }),
    ).toBeUndefined();
    expect(
      deriveConservativeAnimatedBounds({ ...input, nodes: [node(2), node(0), node(0)] }),
    ).toBeUndefined();
    expect(
      deriveConservativeAnimatedBounds({
        ...input,
        channels: [
          { node: 2, property: 'rotation', values: [NaN, 0, 0, 1], interpolation: 'LINEAR' },
        ],
      }),
    ).toBeUndefined();
  });
});
