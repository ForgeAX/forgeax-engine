import type { Meta, StoryObj } from '@storybook/react-vite';
import { Link, Surface, Text } from './components';
import { ColorSpec, SpecSection, TokenValue, specimenGrid } from './storybook/Specimens';

const meta = {
  title: 'Foundations/Colors',
  component: Surface,
  parameters: {
    docs: {
      description: {
        component:
          '颜色全部来自当前主题的 `--fx-color-*` 语义变量。组件不得直接消费 foundation 色值或写死浅色/深色。',
      },
    },
  },
} satisfies Meta<typeof Surface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Surfaces: Story = {
  name: '界面表面',
  parameters: {
    docs: {
      description: {
        story: '表面负责信息分区，不依赖层层套卡或在每个面板上使用阴影。',
      },
    },
  },
  render: () => (
    <SpecSection title="界面表面" description="背景负责分区，近无彩灰阶构成界面的主体。">
      <div style={specimenGrid}>
        <ColorSpec token="--fx-color-surface-canvas" name="主背景" description="页面和工作区的基础表面。" />
        <ColorSpec token="--fx-color-surface-sidebar" name="导航与侧栏" description="导航、选择和辅助区域。" />
        <ColorSpec token="--fx-color-surface-raised" name="浮层表面" description="菜单、弹窗和抬升内容。" />
        <ColorSpec token="--fx-color-surface-inset" name="嵌入内容" description="预览说明、技术内容等次级区域。" />
      </div>
    </SpecSection>
  ),
};

export const TextHierarchy: Story = {
  name: '文字颜色层级',
  parameters: {
    docs: {
      description: {
        story: '文字颜色表达信息权重；disabled 只用于真实禁用，不能代替普通辅助文字。',
      },
    },
  },
  render: () => (
    <SpecSection title="文字层级">
      <div
        style={{
          display: 'grid',
          gap: 1,
          overflow: 'hidden',
          border: 'var(--fx-border-width) solid var(--fx-color-border-default)',
          borderRadius: 'var(--fx-radius-card)',
        }}
      >
        {[
          ['--fx-color-text-primary', '主要文字 · 当前角色与核心操作', '标题、正文、按钮和重要内容。'],
          ['--fx-color-text-secondary', '次要文字 · 参数说明与补充信息', '保持可读，但不与主要内容争抢。'],
          ['--fx-color-text-muted', '弱化文字 · 元数据与提示', '不承载关键结果或操作。'],
          ['--fx-color-text-disabled', '禁用文字 · 暂不可用的操作', '附近仍需清楚说明禁用原因。'],
        ].map(([token, label, description]) => (
          <div key={token} style={{ display: 'grid', gap: 4, padding: 14, background: 'var(--fx-color-surface-raised)' }}>
            <Text variant="body" style={{ color: `var(${token})` }}>{label}</Text>
            <Text variant="caption">{description}</Text>
            <TokenValue token={token} />
          </div>
        ))}
      </div>
    </SpecSection>
  ),
};

export const InteractiveSurfaces: Story = {
  name: '交互表面态',
  parameters: {
    docs: {
      description: {
        story:
          '悬停与选中使用中性表面 token（`surface-hover` / `surface-selected`），不用品牌色表达列表或布局选中。',
      },
    },
  },
  render: () => (
    <SpecSection title="悬停、选中与高亮">
      <div
        style={{
          display: 'grid',
          gap: 1,
          overflow: 'hidden',
          maxWidth: 420,
          border: 'var(--fx-border-width) solid var(--fx-color-border-default)',
          borderRadius: 'var(--fx-radius-card)',
        }}
      >
        {(
          [
            { label: '默认', style: { background: 'var(--fx-color-surface-raised)' } },
            { label: '悬停 · surface-hover', style: { background: 'var(--fx-color-surface-hover)' } },
            { label: '选中 · surface-selected', style: { background: 'var(--fx-color-surface-selected)' } },
            {
              label: '选区 · selection-bg',
              style: { background: 'var(--fx-color-selection-bg)', color: 'var(--fx-color-selection-fg)' },
            },
          ] as const
        ).map(({ label, style }) => (
          <div key={label} style={{ display: 'grid', gap: 4, padding: 14, ...style }}>
            <Text variant="body">{label}</Text>
            <Text variant="caption" tone="secondary">在真实组件中由 :hover、[aria-checked] 或 aria-selected 触发。</Text>
          </div>
        ))}
      </div>
      <div style={specimenGrid}>
        <ColorSpec token="--fx-color-surface-hover" name="表面悬停" description="行、按钮 quiet、菜单项指针悬停。" />
        <ColorSpec token="--fx-color-surface-selected" name="表面选中" description="分段选中、开关轨道开启态。" />
        <ColorSpec token="--fx-color-selection-bg" name="选区背景" description="导航当前项、对话气泡等持续选中。" />
        <ColorSpec token="--fx-color-selection-indicator" name="选中标记" description="开关滑块、range 强调色。" />
      </div>
    </SpecSection>
  ),
};

export const BrandAndFunctional: Story = {
  name: '品牌色与功能色',
  parameters: {
    docs: {
      description: {
        story: '品牌色只作识别和少量强调，不等同于成功色；链接、选中和四类状态具有独立语义。',
      },
    },
  },
  render: () => (
    <SpecSection title="品牌与功能色">
      <div style={specimenGrid}>
        <ColorSpec token="--fx-color-brand-accent" name="品牌识别" description="标志和少量强调，不作为通用成功色。" />
        <ColorSpec token="--fx-color-text-link" name="链接" description="标记可跳转的内容与引用。" />
        <ColorSpec token="--fx-color-selection-indicator" name="选中标记" description="与焦点状态分离，失焦后仍保留。" />
        <ColorSpec token="--fx-color-status-success-fg" name="成功" description="明确说明已经完成的范围。" />
        <ColorSpec token="--fx-color-status-warning-fg" name="警告" description="需要检查，但不等于失败。" />
        <ColorSpec token="--fx-color-status-error-fg" name="错误" description="说明问题并给出恢复操作。" />
        <ColorSpec token="--fx-color-status-info-fg" name="信息" description="表达提示与等待输入。" />
      </div>
      <Text>真实组件示例：<Link href="#resource">查看角色资源</Link></Text>
    </SpecSection>
  ),
};
