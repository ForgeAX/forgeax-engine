import type { AssetError } from './asset-error-contracts';
import type { BuiltinAssetKind, BuiltinAssetPayload } from './asset-runtime';
import type { Result } from './result';

/** A realm-local asset identity. Only its owning asset service can admit it. */
export type AssetHandle<
  Target extends string = string,
  Payload = Target extends BuiltinAssetKind ? BuiltinAssetPayload<Target> : unknown,
> = number & {
  readonly __assetTarget: Target;
  readonly __assetPayload: Payload;
};

/** ECS holds references through this seam; asset payloads never enter its stores. */
export interface AssetReferenceOwner {
  readonly identity: string;
  attach(scope: object): Result<void, AssetError>;
  /** Explicit detached content read; the returned value never aliases current storage. */
  read<K extends string, P>(handle: AssetHandle<K, P>): Result<P, AssetError>;
  validate(handle: number, target?: string): Result<void, AssetError>;
  retain(handle: number, target?: string): Result<void, AssetError>;
  release(handle: number): Result<void, AssetError>;
}
