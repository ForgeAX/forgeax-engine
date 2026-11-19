import { radixSort as originalRadixSort } from 'three/examples/jsm/utils/SortUtils.js';

export type { RadixSortOptions } from 'three/examples/jsm/utils/SortUtils.js';
export interface Uint32RadixSortOptions {
  aux?: Uint32Array;
  get?: (value: number) => number;
  reversed?: boolean;
}
/** The original implementation also accepts Uint32Array and matching caller-owned scratch. */
export const radixSort = originalRadixSort as typeof originalRadixSort &
  ((array: Uint32Array, options?: Uint32RadixSortOptions) => void);
