import { PackageId } from '@forgeax/engine/pack/guid';

export const BODY_QUERY_PACKAGE_ID = '019fb7ce-3f00-7000-8000-000000000202';
const parsed = PackageId.parse(BODY_QUERY_PACKAGE_ID);
if (!parsed.ok) throw new Error('water body query packageId is invalid');
export const BODY_QUERY_PACKAGE_NAMESPACE = parsed.value;
