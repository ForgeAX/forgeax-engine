import { PackageId } from '@forgeax/engine/pack/guid';

export const WAVES_PACKAGE_ID = '019fb7ce-3f00-7000-8000-000000000201';
const parsed = PackageId.parse(WAVES_PACKAGE_ID);
if (!parsed.ok) throw new Error('water waves packageId is invalid');
export const WAVES_PACKAGE_NAMESPACE = parsed.value;
