# @forgeax/view-components

[English](README.md) · [简体中文](README.zh-CN.md)

ForgeaX View 的主题、设计 token 和公共 React 组件。设计来源是
`forgeax-codex-design-system.html` 内嵌 guide 页的
`forgeax-tokens.json` v1.1.0，而不是文档站自身的排版 CSS。

## 使用

应用入口加载一次全局样式：

```ts
import '@forgeax/view-components/styles.css';
```

组件直接从包入口导入：

```tsx
import { Button, Field, TextInput, ThemeProvider } from '@forgeax/view-components';
```

`ColorPicker` 接受归一化的线性 RGB 或 RGBA。点击确定后，`onChange` 发出所选值，
各通道按界面显示精度保留三位小数；取消不改变外部值。Pack 字段保持原有草稿与保存归属。

`InspectorForm`、`InspectorFieldControl` 和 `AssetReferenceField` 接受
`locale: 'en' | 'zh'`，默认为 `'en'`。调用方传入当前语言；表单向嵌套颜色和资产控件
传递该值，不重置本地状态。显式传入的资产 `labels` 覆盖对应的本地化默认值。
`ClipboardProvider.dismissLabel` 用于翻译关闭操作，原始剪贴板诊断保持不变。

基础控件的标签默认使用英文，可显式传入译文：`SearchField.clearLabel`、
`Dialog.closeLabel`、`ToastProvider.dismissLabel`、`Conversation.userLabel`、
`Composer.inputLabel` / `submitLabel`。语言由宿主统一管理，控件不另建语言状态。

`ThemeProvider` 默认跟随系统。偏好值为 `system`、`light` 或 `dark`；
`systemTheme` 可由宿主提供，否则监听系统颜色变化。持久化保存偏好，
根节点 `data-theme` 始终是解析后的 `light` 或 `dark`。主题只改变界面表面，
不应修改模型、材质、纹理或图像内容。

## Token 分层

- `foundation` → `--fx-ref-*`：只供语义层引用。
- `semantic.shared` → `--fx-type-*`、`--fx-space-*` 等共享合同。
- `semantic.light/dark` → `--fx-color-*` 与 `--fx-shadow-*`。
- `component` → `--fx-component-*`：控件和编辑器业务尺寸。

修改 `src/tokens/forgeax.tokens.json` 后运行：

```sh
pnpm generate:tokens
```

生成的 `src/styles/tokens.css` 不应手工编辑。

## Storybook

从仓库根目录启动：

```sh
pnpm storybook
```

静态构建：

```sh
pnpm build:storybook
```

Stories 覆盖基础规则、浅/深主题、控件、反馈、浮层、编辑器模式，以及生成、
加入资源、应用场景、失败恢复等业务状态闭环。
