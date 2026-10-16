# @forgeax/view-components

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
