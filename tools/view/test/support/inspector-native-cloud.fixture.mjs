// Bounded fields copied from the C504 Native T4 cloud-band-wide inspection.
export const nativeCloudInspection = {
  entityId: 'target-7d7d0b13-b083-433a-bf71-de166cf68651:world-aab10e5f-aebc-4816-82a1-f82ccc3e3535-2:2',
  targetId: 'target-7d7d0b13-b083-433a-bf71-de166cf68651',
  worldId: 'world-aab10e5f-aebc-4816-82a1-f82ccc3e3535-2',
  name: 'Volumetric cloud layer',
  assetReferences: {
    references: [
      { key: 'VolumetricCloudLayer.material', component: 'VolumetricCloudLayer', field: 'material',
        origin: 'component', kind: 'cloud-material', handle: 19, status: 'resolved', guid: 'a4db8106-28a7-585a-b6c5-62e9e993303f' },
      { key: 'VolumetricCloudLayer.materialInstance', component: 'VolumetricCloudLayer', field: 'materialInstance',
        origin: 'component', kind: 'cloud-material-instance', handle: 20, status: 'resolved', guid: 'a3f8ddd1-6b4e-58f4-93f2-f0e3f533e270' },
    ],
    truncated: false,
  },
  components: [{ name: 'VolumetricCloudLayer',
    fields: { material: { type: 'asset<cloud-material>' }, materialInstance: { type: 'asset<cloud-material-instance>', default: 0 } },
    values: { material: 19, materialInstance: 20 } }],
};

export const nativeCloudAssets = [
  { guid: 'a4db8106-28a7-585a-b6c5-62e9e993303f', kind: 'cloud-material', sourceKey: 'material/cloud-band', path: 'assets/clouds/clouds.pack.ts', previewable: false },
  { guid: 'a3f8ddd1-6b4e-58f4-93f2-f0e3f533e270', kind: 'cloud-material-instance', sourceKey: 'instance/cloud-band-wide', path: 'assets/clouds/clouds.pack.ts', previewable: false },
];
