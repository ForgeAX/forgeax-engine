import type { Meta, StoryObj } from '@storybook/react-vite';
import { Surface, Text } from './components';
import { SpecSection, TokenValue, specimenGrid } from './storybook/Specimens';

const meta = {
  title: 'Foundations/Shape',
  component: Surface,
  parameters: {
    docs: {
      description: {
        component:
          '圆角由组件语义决定；停靠面板平直相接。阴影只表示真实浮层，不能成为普通面板装饰。',
      },
    },
  },
} satisfies Meta<typeof Surface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Radius: Story = {
  name: '圆角角色',
  render: () => (
    <SpecSection title="圆角角色">
      <div style={specimenGrid}>
        {[
          ['--fx-radius-control', '输入控件'],
          ['--fx-radius-card', '产物与菜单'],
          ['--fx-radius-dialog', '弹窗'],
          ['--fx-radius-composer', '大型输入容器'],
          ['--fx-radius-pill', '轻量操作按钮'],
        ].map(([token, usage]) => (
          <div key={token} style={{ display: 'grid', justifyItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 112,
                height: 72,
                border: 'var(--fx-border-width) solid var(--fx-color-border-essential)',
                borderRadius: `var(${token})`,
                background: 'var(--fx-color-surface-raised)',
              }}
            />
            <TokenValue token={token} />
            <Text variant="caption">{usage}</Text>
          </div>
        ))}
      </div>
    </SpecSection>
  ),
};

export const BordersAndShadows: Story = {
  name: '边框与阴影',
  render: () => (
    <SpecSection title="边框与阴影">
      <div style={specimenGrid}>
        <div style={{ padding: 16, border: 'var(--fx-border-width) solid var(--fx-color-border-default)' }}>
          <Text as="strong">常态轮廓</Text>
          <Text tone="secondary">1px 轻中性线，区分边界而不过度强调。</Text>
          <TokenValue token="--fx-color-border-default" />
        </div>
        <div style={{ padding: 16, border: 'var(--fx-border-width) solid var(--fx-color-border-essential)' }}>
          <Text as="strong">必要识别边界</Text>
          <Text tone="secondary">边界是识别控件的关键信息时增强对比。</Text>
          <TokenValue token="--fx-color-border-essential" />
        </div>
        <div
          style={{
            padding: 16,
            borderRadius: 'var(--fx-radius-popover)',
            background: 'var(--fx-color-surface-raised)',
            boxShadow: 'var(--fx-shadow-floating)',
          }}
        >
          <Text as="strong">浮层抬升</Text>
          <Text tone="secondary">柔和阴影用于菜单和弹窗。</Text>
          <TokenValue token="--fx-shadow-floating" />
        </div>
      </div>
    </SpecSection>
  ),
};
