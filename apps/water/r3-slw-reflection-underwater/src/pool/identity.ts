import { PackageId } from '@forgeax/engine/pack/guid';

const parsed = PackageId.parse('019fcf2d-7100-7000-8000-000000000239');
if (!parsed.ok) throw new Error('Pool packageId is invalid');
export const POOL_PACKAGE = parsed.value;
export const POOL_FIELD = 'water-pool-caustics';
export const POOL_SIM_SIZE = 256;
// Two optical cells per height texel; binary spacing gives shared vertices identical coordinates.
export const POOL_GRID = POOL_SIM_SIZE * 2;
export const POOL_FIELD_SIZE = 1024;
