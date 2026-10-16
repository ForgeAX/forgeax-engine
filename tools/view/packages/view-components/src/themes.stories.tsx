import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, Status, Surface, Text } from './components';
import { ThemeProvider } from './theme';

const meta = {
  title: 'Themes/Light and Dark',
  component: ThemeProvider,
  args: {
    children: null,
  },
  parameters: {
    docs: {
      description: {
        component:
          '默认跟随系统，显式选择白天或夜晚覆盖系统偏好。深色只替换语义表面、文字、边框和状态颜色。两套主题共享组件结构、排版、间距和业务含义。',
      },
    },
  },
} satisfies Meta<typeof ThemeProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PersistentPreference: Story = {
  name: 'Persistent preference',
  parameters: { docs: { description: { story: 'Persistence is optional. Private or sandboxed documents use the default theme when storage is unavailable; theme changes continue to work.' } } },
  render: () => (
    <ThemeProvider persist defaultTheme="light" applyToDocument={false}>
      <Surface tone="canvas" card style={{ padding: 20 }}>
        <Text>Theme persistence tolerates unavailable browser storage.</Text>
      </Surface>
    </ThemeProvider>
  ),
};

export const SameStructure: Story = {
  name: '同结构主题对照',
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
      {(['light', 'dark'] as const).map((theme) => (
        <ThemeProvider key={theme} theme={theme} applyToDocument={false}>
          <Surface tone="canvas" card style={{ display: 'grid', gap: 16, minHeight: 240, padding: 20 }}>
            <Text variant="heading">{theme === 'light' ? '浅色主题' : '深色主题'}</Text>
            <Surface tone="sidebar" card style={{ display: 'grid', gap: 12, padding: 16 }}>
              <Text>主题改变界面表面，不改变创作内容。</Text>
              <Status tone="success">状态由图标和文字共同表达</Status>
              <Button variant="primary">执行主操作</Button>
            </Surface>
          </Surface>
        </ThemeProvider>
      ))}
    </div>
  ),
};
