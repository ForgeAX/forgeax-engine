import { PackageId } from '@forgeax/engine/pack/guid';
const parsed = PackageId.parse('019fcf2d-7100-7000-8000-000000000221');
if (!parsed.ok) throw new Error('water mesh demo packageId is invalid');
export const WATER_MESH_DEMO_PACKAGE = parsed.value;
