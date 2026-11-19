import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import type { AssetHandle, MaterialAsset, MaterialValue } from '@forgeax/engine/types';
import type { RuntimeFormFields } from '../../runtime-form';

const admittedNumber = (value: unknown, min: number, max: number) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max)
    throw new Error('Value outside admitted range');
  return number;
};
const clarityDistanceM = (material: MaterialAsset) => {
  const absorption = material.values?.absorptionPerM as readonly number[] | undefined;
  return absorption?.[1] ? 1 / absorption[1] : 20;
};

/** One detached material observation supplies every field in a form refresh. */
export function createSeaControls(
  assets: Pick<AssetRegistry, 'read' | 'update'>,
  readMaterialHandle: () => AssetHandle<'material', MaterialAsset>,
): RuntimeFormFields {
  return Object.assign([], {
    readFields: () => {
      const handle = readMaterialHandle();
      const material = assets.read(handle).unwrap();
      const write = (key: string, value: MaterialValue) =>
        assets.update(handle, { values: { [key]: value } }).unwrap();
      return [
        {
          name: 'roughness',
          label: '水面光泽（粗糙度）',
          value: material.values?.roughness ?? 0.055,
          set: (value: unknown) => write('roughness', admittedNumber(value, 0.01, 1)),
          read: () => assets.read(handle).unwrap().values?.roughness ?? 0.055,
          min: 0.01,
          max: 1,
          slider: true,
        },
        {
          name: 'clarity',
          label: '清澈距离',
          value: clarityDistanceM(material),
          set: (value: unknown) => {
            const distance = admittedNumber(value, 2, 80);
            write('absorptionPerM', [3 / distance, 1 / distance, 0.5 / distance]);
          },
          read: () => clarityDistanceM(assets.read(handle).unwrap()),
          min: 2,
          max: 80,
          unit: 'm',
          slider: true,
        },
      ];
    },
  });
}
