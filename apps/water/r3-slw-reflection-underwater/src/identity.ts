import { PackageId } from '@forgeax/engine/pack/guid';

const parsed = PackageId.parse('019fcf2d-7100-7000-8000-000000000231');
if (!parsed.ok) throw new Error('Water R3 packageId is invalid');
export const WATER_R3_PACKAGE = parsed.value;
