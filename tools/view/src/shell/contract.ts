export const VIEW_LAYOUT_HOST_ID = 'forgeax-view-layout-host';

export function slotElementId(slot: string) {
  if (typeof slot !== 'string' || slot.trim() === '') {
    throw new TypeError('View shell slot must be a non-empty string');
  }
  return `forgeax-view-slot-${slot}`;
}
