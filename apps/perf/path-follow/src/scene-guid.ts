import { AssetGuid } from '@forgeax/engine-pack/guid';

// Ordinary authored Scene GUID; controls and follower state live in its Pack.
const parsed = AssetGuid.parse('40e2a9a0-d141-5433-8361-f2ca1b1d1bd6');
if (!parsed.ok) throw parsed.error;
export const sceneGuid = parsed.value;
