import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';

const namespace = PackageId.parse('01a13ae4-e859-7481-93f2-cb8ff2edfdf8');
if (!namespace.ok) throw new Error('clearcoat packageId is invalid');
export const CLEARCOAT_PACKAGE_ID = namespace.value;
export const CLEARCOAT_MATERIAL_GUID = AssetGuid.derive(CLEARCOAT_PACKAGE_ID, 'material/clearcoat');
