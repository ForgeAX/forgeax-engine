import type { Meta, StoryObj } from '@storybook/react-vite';
import { CodeHighlight } from './CodeHighlight';

const meta = {
  title: 'Editor Patterns/Code Highlight',
  component: CodeHighlight,
  parameters: {
    docs: {
      description: {
        component: 'Read-only source display with lazy syntax highlighting that follows the View theme.',
      },
    },
  },
  args: {
    content: '<main class="preview">\n  <h1>Game UI</h1>\n</main>',
    lang: 'html',
    name: 'guide.ui.html',
    wrap: false,
  },
} satisfies Meta<typeof CodeHighlight>;

export default meta;
type Story = StoryObj<typeof meta>;

export const HtmlSource: Story = {
  render: (args) => <div style={{ width: 420, height: 260, overflow: 'auto', padding: 16, background: 'var(--fx-color-surface-inset)' }}><CodeHighlight {...args} /></div>,
};

export const CssSource: Story = {
  ...HtmlSource,
  args: { content: '.preview {\n  display: grid;\n  color: #284a5a;\n}', lang: 'css', name: 'guide.ui.css' },
};
