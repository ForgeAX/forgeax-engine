import { SelectionHelper as OriginalSelectionHelper } from 'three/examples/jsm/interactive/SelectionHelper.js';
/** The original browser helper only consumes the host's HTML canvas. */
export interface SelectionCanvasHost {
  domElement: HTMLCanvasElement;
}
export interface SelectionHelper {
  element: HTMLDivElement;
  renderer: SelectionCanvasHost;
  isDown: boolean;
  enabled: boolean;
  dispose(): void;
}
export const SelectionHelper = OriginalSelectionHelper as unknown as Omit<
  typeof OriginalSelectionHelper,
  'prototype'
> & {
  new (renderer: SelectionCanvasHost, cssClassName: string): SelectionHelper;
  readonly prototype: SelectionHelper;
};
