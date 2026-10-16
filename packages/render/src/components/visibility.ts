import { defineComponent } from '@forgeax/engine-ecs';

/** Numeric labels stored by the public Visibility enum field. */
export const VisibilityStateValue = Object.freeze({
  inherited: 0,
  hidden: 1,
  visible: 2,
} as const);

/** Author visibility intent accepted by the Visibility component. */
export type VisibilityState = keyof typeof VisibilityStateValue;

/**
 * Decode the stored u32 without treating an unknown value as a valid state.
 * Invalid values are rejected at ECS write boundaries; undefined remains an
 * explicit signal for readers that inspect externally corrupted columns.
 */
export function visibilityStateFromU32(value: number): VisibilityState | undefined {
  switch (value) {
    case VisibilityStateValue.inherited:
      return 'inherited';
    case VisibilityStateValue.hidden:
      return 'hidden';
    case VisibilityStateValue.visible:
      return 'visible';
    default:
      return undefined;
  }
}

/**
 * Author intent for render participation. Omitted state is inherited and is
 * therefore visible when no valid parent intent is available.
 */
export const Visibility = defineComponent(
  'Visibility',
  {
    state: {
      type: 'enum',
      default: VisibilityStateValue.inherited,
      labels: VisibilityStateValue,
    },
  },
  {
    meta: {
      quickStart: 'Attach Visibility to author render participation intent.',
      diagnostics: 'Compare the ECS state with resolveVisibility and renderer.visibilityStats.',
      recovery: 'Use structured ECS write errors and repair the owning scene relation.',
      boundaries:
        'Visibility does not own camera, picking, lifecycle, assets, or VFX shadow policy.',
    },
  },
);
