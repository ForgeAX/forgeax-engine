export const themeNames = ['light', 'dark'] as const;
export type ThemeName = (typeof themeNames)[number];

export const typographyTokens = {
  title: '--fx-type-title',
  heading: '--fx-type-heading',
  body: '--fx-type-body',
  ui: '--fx-type-ui',
  label: '--fx-type-label',
  compact: '--fx-type-compact',
  caption: '--fx-type-caption',
  code: '--fx-type-code',
} as const;

export const colorTokens = {
  surface: {
    canvas: '--fx-color-surface-canvas',
    sidebar: '--fx-color-surface-sidebar',
    raised: '--fx-color-surface-raised',
    inset: '--fx-color-surface-inset',
    hover: '--fx-color-surface-hover',
    selected: '--fx-color-surface-selected',
  },
  text: {
    primary: '--fx-color-text-primary',
    secondary: '--fx-color-text-secondary',
    muted: '--fx-color-text-muted',
    disabled: '--fx-color-text-disabled',
    inverse: '--fx-color-text-inverse',
    link: '--fx-color-text-link',
  },
  border: {
    subtle: '--fx-color-border-subtle',
    default: '--fx-color-border-default',
    control: '--fx-color-border-control',
    strong: '--fx-color-border-strong',
    focus: '--fx-color-border-focus',
    essential: '--fx-color-border-essential',
  },
  action: {
    primaryBackground: '--fx-color-action-primary-bg',
    primaryForeground: '--fx-color-action-primary-fg',
    primaryHover: '--fx-color-action-primary-hover',
    primaryPressed: '--fx-color-action-primary-pressed',
    secondaryBackground: '--fx-color-action-secondary-bg',
    secondaryForeground: '--fx-color-action-secondary-fg',
    secondaryHover: '--fx-color-action-secondary-hover',
    disabledBackground: '--fx-color-action-disabled-bg',
    disabledForeground: '--fx-color-action-disabled-fg',
    dangerBackground: '--fx-color-action-danger-bg',
    dangerForeground: '--fx-color-action-danger-fg',
  },
  selection: {
    background: '--fx-color-selection-bg',
    foreground: '--fx-color-selection-fg',
    indicator: '--fx-color-selection-indicator',
  },
  brand: {
    accent: '--fx-color-brand-accent',
    text: '--fx-color-brand-text',
    soft: '--fx-color-brand-soft',
    onAccent: '--fx-color-brand-on-accent',
  },
  status: {
    successForeground: '--fx-color-status-success-fg',
    successBackground: '--fx-color-status-success-bg',
    warningForeground: '--fx-color-status-warning-fg',
    warningBackground: '--fx-color-status-warning-bg',
    errorForeground: '--fx-color-status-error-fg',
    errorBackground: '--fx-color-status-error-bg',
    infoForeground: '--fx-color-status-info-fg',
    infoBackground: '--fx-color-status-info-bg',
  },
  scrim: '--fx-color-scrim',
  choiceIndicator: '--fx-color-choice-indicator',
} as const;

export const surfaceTokens = colorTokens.surface;

export const statusTokens = {
  success: {
    foreground: '--fx-color-status-success-fg',
    background: '--fx-color-status-success-bg',
  },
  warning: {
    foreground: '--fx-color-status-warning-fg',
    background: '--fx-color-status-warning-bg',
  },
  error: {
    foreground: '--fx-color-status-error-fg',
    background: '--fx-color-status-error-bg',
  },
  info: {
    foreground: '--fx-color-status-info-fg',
    background: '--fx-color-status-info-bg',
  },
} as const;

export const spaceTokens = {
  inline: '--fx-space-inline',
  control: '--fx-space-control',
  stack: '--fx-space-stack',
  section: '--fx-space-section',
  page: '--fx-space-page',
} as const;

export const shapeTokens = {
  radius: {
    control: '--fx-radius-control',
    card: '--fx-radius-card',
    popover: '--fx-radius-popover',
    dialog: '--fx-radius-dialog',
    composer: '--fx-radius-composer',
    pill: '--fx-radius-pill',
  },
  border: {
    width: '--fx-border-width',
    focusWidth: '--fx-border-focus-width',
    focusOffset: '--fx-border-focus-offset',
  },
  shadow: {
    subtle: '--fx-shadow-subtle',
    floating: '--fx-shadow-floating',
    dialog: '--fx-shadow-dialog',
  },
} as const;

export const motionTokens = {
  feedback: '--fx-motion-feedback',
  hover: '--fx-motion-hover',
  expand: '--fx-motion-expand',
  panel: '--fx-motion-panel',
  easing: '--fx-motion-ease',
} as const;

export const layerTokens = {
  content: '--fx-layer-content',
  sticky: '--fx-layer-sticky',
  popover: '--fx-layer-popover',
  dialog: '--fx-layer-dialog',
  toast: '--fx-layer-toast',
  tooltip: '--fx-layer-tooltip',
} as const;

export const componentTokens = {
  controlHeightCompact: '--fx-component-control-height-compact',
  controlHeightDefault: '--fx-component-control-height-default',
  controlHeightLarge: '--fx-component-control-height-large',
  controlIconSize: '--fx-component-control-icon-size',
  controlIconHitAreaMin: '--fx-component-control-icon-hit-area-min',
  fieldHeightDefault: '--fx-component-field-height-default',
  navigationRowHeight: '--fx-component-navigation-row-height',
  editorRowHeight: '--fx-component-editor-row-height',
  panelHeaderHeight: '--fx-component-panel-header-height',
  navigationRailWidth: '--fx-component-navigation-rail-width',
  panelConfigMinWidth: '--fx-component-panel-config-min-width',
  panelConfigMaxWidth: '--fx-component-panel-config-max-width',
  panelChatMinWidth: '--fx-component-panel-chat-min-width',
  panelChatDefaultWidth: '--fx-component-panel-chat-default-width',
  menuRowHeight: '--fx-component-menu-row-height',
  menuMinWidth: '--fx-component-menu-min-width',
  dialogMaxWidth: '--fx-component-dialog-max-width',
  dialogPadding: '--fx-component-dialog-padding',
  conversationMaxWidth: '--fx-component-conversation-max-width',
  conversationMessageGap: '--fx-component-conversation-message-gap',
  composerRadius: '--fx-component-composer-radius',
  composerMinHeight: '--fx-component-composer-min-height',
  composerTextMaxHeight: '--fx-component-composer-text-max-height',
  tooltipDelay: '--fx-component-tooltip-delay',
  spinnerDuration: '--fx-component-status-spinner-duration',
  buttonRadius: '--fx-component-button-radius',
  choiceSize: '--fx-component-choice-size',
  choiceDotSize: '--fx-component-choice-dot-size',
} as const;

