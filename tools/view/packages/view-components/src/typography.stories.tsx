import type { Meta, StoryObj } from '@storybook/react-vite';
import { Text, type TextVariant } from './components';
import { SpecSection, useResolvedToken } from './storybook/Specimens';

const meta = {
  title: 'Foundations/Typography',
  component: Text,
  parameters: {
    docs: {
      description: {
        component:
          'Text 将规范中的八种语义字阶映射到真实 `--fx-type-*` token。普通按钮和标签保持常规字重，只有小标题适度加重。',
      },
    },
  },
  argTypes: {
    as: { control: false },
    children: { control: 'text' },
    variant: {
      control: 'select',
      options: ['title', 'heading', 'body', 'ui', 'label', 'compact', 'caption', 'code'],
    },
    tone: {
      control: 'select',
      options: ['primary', 'secondary', 'muted'],
    },
  },
} satisfies Meta<typeof Text>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  args: {
    children: '创建你的下一位角色',
    variant: 'title',
    tone: 'primary',
  },
};

const specs: Array<[TextVariant, string, string]> = [
  ['title', '页面标题', '3D 角色生成'],
  ['heading', '区域标题', '颜色与表面'],
  ['body', '长正文', '描述角色的外形与游戏用途。'],
  ['ui', '常规界面', '角色名称与参数'],
  ['label', '控件标签', '生成质量'],
  ['compact', '紧凑编辑', '位置与尺寸'],
  ['caption', '辅助说明', '参数已保存'],
  ['code', '技术内容', 'character.glb'],
];

function TypeRow({ variant, name, sample }: { variant: TextVariant; name: string; sample: string }) {
  const size = useResolvedToken(`--fx-type-${variant}-font-size`);
  const weight = useResolvedToken(`--fx-type-${variant}-font-weight`);
  const lineHeight = useResolvedToken(`--fx-type-${variant}-line-height`);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '130px 150px minmax(220px, 1fr)',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        borderBottom: 'var(--fx-border-width) solid var(--fx-color-border-subtle)',
      }}
    >
      <Text variant="label">{name}</Text>
      <Text variant="code" tone="muted">{size} / {weight} / {lineHeight}</Text>
      <Text variant={variant}>{sample}</Text>
    </div>
  );
}

export const Hierarchy: Story = {
  name: '完整文字字阶',
  parameters: {
    docs: {
      description: {
        story: '每行展示组件实际使用的字号、字重和行高；切换浅/深主题不会改变排版结构。',
      },
    },
  },
  render: () => (
    <SpecSection
      title="字体与排版"
      description="系统无衬线用于界面与中文，等宽字体用于文件、数据和技术信息。"
    >
      <div
        style={{
          overflow: 'hidden',
          border: 'var(--fx-border-width) solid var(--fx-color-border-default)',
          borderRadius: 'var(--fx-radius-card)',
        }}
      >
        {specs.map(([variant, name, sample]) => (
          <TypeRow key={variant} variant={variant} name={name} sample={sample} />
        ))}
      </div>
    </SpecSection>
  ),
};
