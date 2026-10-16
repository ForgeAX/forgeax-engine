import { describe, expectTypeOf, it } from 'vitest';
import type {
  MATERIAL_ERROR_CODES,
  MaterialError,
  MaterialErrorCode,
  MaterialErrorDetail,
} from '../material/errors.js';

const expectedCodes = [
  'material-output-contract-invalid',
  'material-parent-not-found',
  'material-circular-inheritance',
  'material-child-contract-invalid',
  'material-no-effective-pass',
  'material-value-unknown',
  'material-value-type-mismatch',
  'material-parameter-type-unsupported',
  'material-contract-program-mismatch',
  'shader-module-id-missing',
  'shader-module-id-duplicate',
  'shader-module-not-found',
  'shader-module-namespace-reserved',
  'material-reflection-binding-mismatch',
  'material-specialization-not-cooked',
  'material-specialization-stale-generation',
  'gltf-material-uv-set-missing',
  'material-derived-interface-mismatch',
  'material-texture-coordinate-invalid',
  'material-payload-bounds',
  'material-transmission-contract-invalid',
  'material-physical-contract-invalid',
  'material-tangent-required',
  'material-surface-slot-missing',
  'material-surface-abi-mismatch',
  'material-surface-forbidden-interface',
] as const;

declare const error: MaterialError;

function renderDiagnostic(error: MaterialError): string {
  switch (error.code) {
    case 'material-output-contract-invalid':
      return error.detail.reason;
    case 'material-parent-not-found':
      return error.detail.missingParent;
    case 'material-circular-inheritance':
      return error.detail.chain.join(' -> ');
    case 'material-child-contract-invalid':
      return `${error.detail.material}:${error.detail.parent}`;
    case 'material-no-effective-pass':
      return error.detail.material;
    case 'material-value-unknown':
      return error.detail.parameter;
    case 'material-value-type-mismatch':
      return `${error.detail.parameter}:${error.detail.expectedType}`;
    case 'material-parameter-type-unsupported':
      return `${error.detail.material}:${error.detail.parameter}:${error.detail.type}`;
    case 'material-contract-program-mismatch':
      return `${error.detail.pass}:${error.detail.program}`;
    case 'shader-module-id-missing':
      return error.detail.source;
    case 'shader-module-id-duplicate':
      return error.detail.module;
    case 'shader-module-not-found':
      return error.detail.module;
    case 'shader-module-namespace-reserved':
      return error.detail.module;
    case 'material-reflection-binding-mismatch':
      return error.detail.parameter;
    case 'material-specialization-not-cooked':
      return error.detail.material;
    case 'material-specialization-stale-generation':
      return error.detail.material;
    case 'gltf-material-uv-set-missing':
      return `${error.detail.material}:${error.detail.slot}`;
    case 'material-derived-interface-mismatch':
      return `${error.detail.material}:${error.detail.layoutIdentity}:${error.detail.action}`;
    case 'material-texture-coordinate-invalid':
      return `${error.detail.parameter}:${error.detail.slot}:${error.detail.reason}`;
    case 'material-payload-bounds':
      return `${error.detail.slot}:${error.detail.byteOffset}:${error.detail.byteLength}`;
    case 'material-transmission-contract-invalid':
      return `${error.detail.material}:${error.detail.parameter}:${error.detail.reason}`;
    case 'material-physical-contract-invalid':
      return `${error.detail.material}:${error.detail.layer}:${error.detail.reason}`;
    case 'material-tangent-required':
      return `${error.detail.material}:${error.detail.mesh}:${error.detail.layer}:${error.detail.uv}`;
    case 'material-surface-slot-missing':
      return `${error.detail.material}:${error.detail.pass}:${error.detail.slot}`;
    case 'material-surface-abi-mismatch':
      return `${error.detail.material}:${error.detail.pass}:${error.detail.action}`;
    case 'material-surface-forbidden-interface':
      return `${error.detail.material}:${error.detail.pass}:${error.detail.interface}`;
  }
}

describe('MaterialError closed contract', () => {
  it('projects the complete detail family from the material error union', () => {
    expectTypeOf<MaterialErrorDetail>().toEqualTypeOf<MaterialError['detail']>();
  });

  it('keeps the planned error code set closed and discoverable', () => {
    expectTypeOf<typeof MATERIAL_ERROR_CODES>().toEqualTypeOf<typeof expectedCodes>();
    expectTypeOf<MaterialErrorCode>().toEqualTypeOf<(typeof expectedCodes)[number]>();
  });

  it('narrows detail by code without reading message text', () => {
    const diagnostic = renderDiagnostic(error);

    expectTypeOf(diagnostic).toBeString();
    expectTypeOf<MaterialError['expected']>().toBeString();
    expectTypeOf<MaterialError['hint']>().toBeString();
    expectTypeOf<MaterialError['code']>().toBeString();
  });
});
