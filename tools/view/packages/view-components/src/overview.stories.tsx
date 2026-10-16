import type { Meta, StoryObj } from '@storybook/react-vite';
import { Text } from './components';
import { SpecSection, specimenGrid } from './storybook/Specimens';

const meta = {
  title: 'Foundations/Overview',
  parameters: {
    docs: {
      description: {
        component:
          'ForgeaX View UI 的总设计原则。主题、token 和组件都必须服从这些边界，而不是把装饰样式当成规范。',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Principles: Story = {
  name: '核心原则',
  parameters: {
    docs: {
      description: {
        story: '规范的三个约束：内容优先、状态明确但克制、界面主题与创作内容相互独立。',
      },
    },
  },
  render: () => (
    <SpecSection
      title="ForgeaX 界面设计原则"
      description="浅色默认，深色保持同一信息结构，让配置、编辑和预览保持清楚的主次关系。"
    >
      <div style={specimenGrid}>
        {[
          ['内容先于装饰', '正文和工作内容是主体。用留白、对齐和轻分隔组织信息，避免层层套卡。'],
          ['状态清楚，强调克制', '同一操作区只突出一个主操作；状态使用小图标与文字，不铺满界面。'],
          ['控件统一，内容独立', '主题只改变界面表面，不改变模型、材质、纹理和图像本身的颜色。'],
        ].map(([title, description]) => (
          <div
            key={title}
            style={{
              display: 'grid',
              alignContent: 'start',
              gap: 8,
              padding: 16,
              borderTop: 'var(--fx-border-width) solid var(--fx-color-border-default)',
            }}
          >
            <Text as="strong" variant="heading">{title}</Text>
            <Text tone="secondary">{description}</Text>
          </div>
        ))}
      </div>
    </SpecSection>
  ),
};
