import { AssetGuid, PackageId } from '@forgeax/engine/pack/guid';

const parsed = PackageId.parse('019fcf2d-8100-7000-8000-000000000291');
if (!parsed.ok) throw parsed.error;
export const WATER_R0_PACKAGE = parsed.value;
export const r0Guid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_R0_PACKAGE, key));
