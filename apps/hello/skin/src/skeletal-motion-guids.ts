import { AssetGuid, PackageId } from '@forgeax/engine/pack/guid';

const parsed = PackageId.parse('019fb265-1819-7000-8000-000000000001');
if (!parsed.ok) throw parsed.error;
export const MOTION_PACKAGE_ID = parsed.value;
export const motionGuid = (key: string) =>
  AssetGuid.format(AssetGuid.derive(MOTION_PACKAGE_ID, key));
