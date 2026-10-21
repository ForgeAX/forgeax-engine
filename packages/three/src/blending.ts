import type { Material } from 'three/src/Three.Core.js';
import {
  AddEquation,
  AdditiveBlending,
  CustomBlending,
  DstAlphaFactor,
  DstColorFactor,
  MaxEquation,
  MinEquation,
  MultiplyBlending,
  NoBlending,
  NormalBlending,
  OneFactor,
  OneMinusDstAlphaFactor,
  OneMinusDstColorFactor,
  OneMinusSrcAlphaFactor,
  OneMinusSrcColorFactor,
  ReverseSubtractEquation,
  SrcAlphaFactor,
  SrcAlphaSaturateFactor,
  SrcColorFactor,
  SubtractEquation,
  SubtractiveBlending,
  ZeroFactor,
} from 'three/src/Three.Core.js';
import { unsupported } from './errors';

const factors: Readonly<Record<number, GPUBlendFactor>> = {
  [ZeroFactor]: 'zero',
  [OneFactor]: 'one',
  [SrcColorFactor]: 'src',
  [OneMinusSrcColorFactor]: 'one-minus-src',
  [SrcAlphaFactor]: 'src-alpha',
  [OneMinusSrcAlphaFactor]: 'one-minus-src-alpha',
  [DstAlphaFactor]: 'dst-alpha',
  [OneMinusDstAlphaFactor]: 'one-minus-dst-alpha',
  [DstColorFactor]: 'dst',
  [OneMinusDstColorFactor]: 'one-minus-dst',
  [SrcAlphaSaturateFactor]: 'src-alpha-saturated',
};
const operations: Readonly<Record<number, GPUBlendOperation>> = {
  [AddEquation]: 'add',
  [SubtractEquation]: 'subtract',
  [ReverseSubtractEquation]: 'reverse-subtract',
  [MinEquation]: 'min',
  [MaxEquation]: 'max',
};

/** Static WebGPU blend state; dynamic blend constants need a native draw contract. */
export function projectBlending(material: Material): GPUBlendState | undefined {
  if (
    material.blending === NoBlending ||
    (material.blending === NormalBlending && !material.transparent)
  )
    return undefined;
  if (material.blending === CustomBlending) {
    const component = (src: number, dst: number, equation: number): GPUBlendComponent => {
      const operation = operations[equation],
        srcFactor = factors[src],
        dstFactor = factors[dst];
      if (operation === undefined || srcFactor === undefined || dstFactor === undefined)
        return unsupported(
          'CustomBlending equation/factor; constant factors require native blend-constant authoring',
          material.uuid,
        ).unwrap();
      // WebGPU min/max ignores factors and requires their identity defaults.
      return operation === 'min' || operation === 'max'
        ? { operation }
        : { operation, srcFactor, dstFactor };
    };
    return {
      color: component(material.blendSrc, material.blendDst, material.blendEquation),
      alpha: component(
        material.blendSrcAlpha ?? material.blendSrc,
        material.blendDstAlpha ?? material.blendDst,
        material.blendEquationAlpha ?? material.blendEquation,
      ),
    };
  }
  if (material.blending === SubtractiveBlending || material.blending === MultiplyBlending) {
    if (!material.premultipliedAlpha)
      return unsupported(
        'WebGPU subtractive/multiply blending requires premultipliedAlpha',
        material.uuid,
      ).unwrap();
    return {
      color:
        material.blending === SubtractiveBlending
          ? { srcFactor: 'zero', dstFactor: 'one-minus-src', operation: 'add' }
          : { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    };
  }
  if (material.blending !== NormalBlending && material.blending !== AdditiveBlending)
    return unsupported('Material.blending', material.uuid).unwrap();
  const dstFactor = material.blending === NormalBlending ? 'one-minus-src-alpha' : 'one';
  return {
    color: {
      srcFactor: material.premultipliedAlpha ? 'one' : 'src-alpha',
      dstFactor,
      operation: 'add',
    },
    alpha: { srcFactor: 'one', dstFactor, operation: 'add' },
  };
}
