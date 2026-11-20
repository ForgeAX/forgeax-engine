# @forgeax/view-components

[English](README.md) · [简体中文](README.zh-CN.md)

Themes, design tokens and public React components for ForgeaX View. The design
source is `forgeax-tokens.json` v1.1.0 in the embedded guide of
`forgeax-codex-design-system.html`, rather than the documentation site's layout CSS.

## Usage

Load global styles once at the application entry:

```ts
import '@forgeax/view-components/styles.css';
```

Import components directly from the package entry:

```tsx
import { Button, Field, TextInput, ThemeProvider } from '@forgeax/view-components';
```

`ColorPicker` accepts normalized linear RGB or RGBA. Its `onChange` emits the
selected value on OK with channels rounded to the displayed three decimals;
Cancel leaves the external value unchanged. Pack fields retain their existing
draft and Save ownership.

`InspectorForm`, `InspectorFieldControl` and `AssetReferenceField` accept
`locale: 'en' | 'zh'` (default `'en'`). The caller supplies its current language;
forms pass it to nested color and asset controls without resetting local state.
Explicit asset `labels` override the corresponding localized defaults.
`ClipboardProvider.dismissLabel` localizes its dismiss action while preserving
the original clipboard diagnostic.

Primitive labels default to English and accept explicit translations:
`SearchField.clearLabel`, `Dialog.closeLabel`, `ToastProvider.dismissLabel`,
`Conversation.userLabel` and `Composer.inputLabel` / `submitLabel`.
The host owns the language; these controls do not keep a second locale store.

`ThemeProvider` follows the system by default. Preferences are `system`, `light`
or `dark`; the host can supply `systemTheme`, otherwise OS appearance changes
are observed. Preferences persist; the root `data-theme` always resolves to
`light` or `dark`. Themes affect UI surfaces only, never models, materials,
textures or image content.

## Token Layers

- `foundation` → `--fx-ref-*`: references for the semantic layer only.
- `semantic.shared` → shared contracts such as `--fx-type-*` and `--fx-space-*`.
- `semantic.light/dark` → `--fx-color-*` and `--fx-shadow-*`.
- `component` → `--fx-component-*`: control and editor dimensions.

After changing `src/tokens/forgeax.tokens.json`, run:

```sh
pnpm generate:tokens
```

Do not edit the generated `src/styles/tokens.css` manually.

## Storybook

Start from the repository root:

```sh
pnpm storybook
```

Build the static site:

```sh
pnpm build:storybook
```

Stories cover foundations, light/dark themes, controls, feedback, overlays,
editor patterns, generation, adding assets, applying scenes and failure recovery.
