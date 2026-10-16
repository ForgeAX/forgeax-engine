/** Workbench zones aligned with forgeax-interface rail / main / detail composition. */
export const VIEW_LAYOUT_ZONES = Object.freeze({
  left: 'left',
  center: 'center',
  right: 'right',
  displayChrome: 'display-chrome',
});

export const VIEW_LAYOUT_ZONE_ORDER = Object.freeze({
  [VIEW_LAYOUT_ZONES.left]: 0,
  [VIEW_LAYOUT_ZONES.center]: 1,
  [VIEW_LAYOUT_ZONES.right]: 2,
  [VIEW_LAYOUT_ZONES.displayChrome]: 3,
});
