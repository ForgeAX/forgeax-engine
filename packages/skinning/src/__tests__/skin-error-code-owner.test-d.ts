import type { resolveSkinJoints } from '@forgeax/engine-skinning';
import type { SkinError, SkinErrorCode, SkinExtractErrorCode } from '../errors.js';

type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
    ? true
    : false;

type Assert<Value extends true> = Value;

type ExpectedSkinErrorCodes =
  | 'skin-asset-unresolved'
  | 'skin-joint-path-unresolved'
  | 'skin-instances-coexist-forbidden'
  | 'skeleton-resolve-failed'
  | 'joint-count-mismatch'
  | 'joint-entity-dangling';

type _SkinErrorCodeDerivesFromSkinError = Assert<Equal<SkinErrorCode, SkinError['code']>>;

type _SkinErrorCodeHasExactMembership = Assert<Equal<SkinErrorCode, ExpectedSkinErrorCodes>>;

type _SkinExtractErrorCodeIsASkinErrorCode = Assert<
  SkinExtractErrorCode extends SkinErrorCode ? true : false
>;

type ResolveSkinJointsError = Extract<ReturnType<typeof resolveSkinJoints>, { ok: false }>['error'];
type _ResolveSkinJointsUsesSkinErrorAuthority = Assert<Equal<ResolveSkinJointsError, SkinError>>;

declare const extractCode: SkinExtractErrorCode;
const acceptsSkinErrorCode = (code: SkinErrorCode): SkinErrorCode => code;
acceptsSkinErrorCode(extractCode);

// @ts-expect-error invalid codes must not be accepted.
acceptsSkinErrorCode('not-a-skin-error');

function narrowSkinErrorDetail(error: SkinError): void {
  switch (error.code) {
    case 'skin-asset-unresolved': {
      const handle: number = error.detail.skeletonHandle;
      void handle;
      break;
    }
    case 'skin-joint-path-unresolved': {
      const path: readonly string[] = error.detail.path;
      void path;
      // @ts-expect-error code-driven narrowing excludes unrelated detail fields.
      void error.detail.jointCount;
      break;
    }
    case 'joint-count-mismatch': {
      const actual: number = error.detail.actual;
      void actual;
      break;
    }
    case 'skeleton-resolve-failed': {
      const skeletonHandle: number = error.detail.skeletonHandle;
      void skeletonHandle;
      break;
    }
    case 'skin-instances-coexist-forbidden': {
      void error.detail.entity;
      break;
    }
    case 'joint-entity-dangling': {
      void error.detail.jointIndex;
      break;
    }
    default: {
      const exhaustive: never = error;
      void exhaustive;
    }
  }
}

export type _SkinErrorCodeOwnerChecks = {
  /** @internal */
  _derived: _SkinErrorCodeDerivesFromSkinError;
  /** @internal */
  _membership: _SkinErrorCodeHasExactMembership;
  /** @internal */
  _extractSubset: _SkinExtractErrorCodeIsASkinErrorCode;
  /** @internal */
  _resolveAuthority: _ResolveSkinJointsUsesSkinErrorAuthority;
  /** @internal */
  _narrowDetail: typeof narrowSkinErrorDetail;
};
