import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Button, Surface, Text } from './components';
import { SpecSection, TokenValue, specimenGrid } from './storybook/Specimens';

const meta = {
  title: 'Accessibility/Motion and Keyboard',
  component: Button,
  parameters: {
    docs: {
      description: {
        component:
          '动效解释状态变化但不承担唯一信息。系统启用减少动效时，非必要时长归零，同时保留可见的静态反馈。',
      },
    },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

function MotionExample() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <span
        style={{
          display: 'block',
          width: expanded ? 112 : 40,
          height: 40,
          borderRadius: 'var(--fx-radius-control)',
          background: 'var(--fx-color-selection-indicator)',
          transition: 'width var(--fx-motion-panel) var(--fx-motion-ease)',
        }}
      />
      <Button size="compact" onClick={() => setExpanded((value) => !value)}>播放动效示例</Button>
    </div>
  );
}

export const MotionDurations: Story = {
  name: '动效时长',
  render: () => (
    <SpecSection title="动效">
      <div style={specimenGrid}>
        {[
          ['--fx-motion-feedback', '按压反馈'],
          ['--fx-motion-hover', '悬停变化'],
          ['--fx-motion-expand', '内容展开'],
          ['--fx-motion-panel', '面板切换'],
        ].map(([token, usage]) => (
          <Surface key={token} tone="raised" card style={{ display: 'grid', gap: 6, padding: 14 }}>
            <TokenValue token={token} />
            <Text tone="secondary">{usage}</Text>
          </Surface>
        ))}
      </div>
      <MotionExample />
    </SpecSection>
  ),
};

export const AccessibilityRules: Story = {
  name: '键盘与内容可访问性',
  render: () => (
    <SpecSection title="可访问性规则">
      <ul style={{ display: 'grid', gap: 10, margin: 0, paddingLeft: 22 }}>
        <li>支持 Tab、Enter、Space 和 Esc；焦点顺序与视觉顺序一致。</li>
        <li>浮层关闭后焦点回到触发入口；弹窗必须有清楚标题。</li>
        <li>必要信息保持足够对比度，不能只使用颜色区分状态。</li>
        <li>截断名称、无文字图标和禁用原因提供可访问说明。</li>
        <li>图像、模型和纹理保持原色，不随界面主题机械反转。</li>
      </ul>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button>按 Tab 聚焦我</Button>
        <Button disabled title="请先选择资源">带原因的禁用操作</Button>
      </div>
    </SpecSection>
  ),
};
