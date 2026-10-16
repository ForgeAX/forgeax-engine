import type { Meta, StoryObj } from '@storybook/react-vite';
import { Surface, Text } from './components';
import { SpecSection, TokenValue, specimenGrid } from './storybook/Specimens';

const meta = {
  title: 'Foundations/Spacing',
  component: Surface,
  parameters: {
    docs: {
      description: {
        component:
          '间距使用 foundation 标尺和 component 尺寸合同。相关元素靠近，独立内容之间使用更大间距。',
      },
    },
  },
} satisfies Meta<typeof Surface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Scale: Story = {
  name: '间距标尺',
  render: () => (
    <SpecSection title="间距标尺">
      <div style={{ display: 'grid', gap: 10 }}>
        {[
          ['--fx-ref-space-4', '细微调整与紧密元素'],
          ['--fx-ref-space-8', '图标、按钮组等关联内容'],
          ['--fx-ref-space-12', '纵向内容组'],
          ['--fx-ref-space-16', '字段与面板内边距'],
          ['--fx-ref-space-24', '独立区块之间'],
          ['--fx-ref-space-32', '页面边距与大区块'],
          ['--fx-ref-space-48', '章节之间'],
        ].map(([token, usage]) => (
          <div key={token} style={{ display: 'grid', gridTemplateColumns: '190px 170px 1fr', alignItems: 'center', gap: 12 }}>
            <TokenValue token={token} />
            <span style={{ width: `calc(var(${token}) * 3)`, height: 8, background: 'var(--fx-color-selection-indicator)' }} />
            <Text tone="secondary">{usage}</Text>
          </div>
        ))}
      </div>
    </SpecSection>
  ),
};

export const ComponentDimensions: Story = {
  name: '控件与布局尺寸',
  render: () => (
    <SpecSection
      title="控件与布局尺寸"
      description="编辑区域保持紧凑；长阅读和独立内容保持舒展。"
    >
      <div style={specimenGrid}>
        {[
          ['--fx-component-control-height-compact', '紧凑控件', '编辑工具与次要操作'],
          ['--fx-component-control-height-default', '常规控件', '日常按钮与选择'],
          ['--fx-component-navigation-row-height', '导航与菜单', '稳定的点击区域'],
          ['--fx-component-control-height-large', '大型主操作', '重要操作与触控场景'],
          ['--fx-component-panel-config-min-width', '配置区最小宽度', '配置独立滚动'],
          ['--fx-component-panel-config-max-width', '配置区最大宽度', '主操作固定在底部'],
        ].map(([token, name, usage]) => (
          <Surface key={token} tone="raised" card style={{ display: 'grid', gap: 6, padding: 14 }}>
            <Text as="strong" variant="label">{name}</Text>
            <TokenValue token={token} />
            <Text variant="caption">{usage}</Text>
          </Surface>
        ))}
      </div>
    </SpecSection>
  ),
};
