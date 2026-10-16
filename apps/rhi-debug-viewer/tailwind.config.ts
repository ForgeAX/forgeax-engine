import type { Config } from 'tailwindcss';

const color = (name: string) => `rgb(from var(--${name}) r g b / <alpha-value>)`;

const config: Config = {
  content: ['./src/**/*.{ts,tsx,html}'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      spacing: {
        'fx-2': 'var(--fx-ref-space-2)',
        'fx-4': 'var(--fx-ref-space-4)',
        'fx-6': 'var(--fx-ref-space-6)',
        'fx-8': 'var(--fx-ref-space-8)',
        'fx-12': 'var(--fx-ref-space-12)',
        'fx-16': 'var(--fx-ref-space-16)',
        'fx-24': 'var(--fx-ref-space-24)',
      },
      fontWeight: {
        medium: 'var(--fx-ref-font-weight-500)',
        semibold: 'var(--fx-ref-font-weight-600)',
      },
      borderWidth: {
        DEFAULT: 'var(--fx-border-width)',
        2: 'var(--fx-border-focus-width)',
      },
      colors: {
        border: color('fx-color-border-default'),
        background: color('fx-color-surface-canvas'),
        foreground: color('fx-color-text-primary'),
        muted: {
          DEFAULT: color('fx-color-surface-hover'),
          foreground: color('fx-color-text-muted'),
        },
        card: color('fx-color-surface-raised'),
        danger: color('fx-color-status-error-fg'),
        success: color('fx-color-status-success-fg'),
      },
      borderRadius: {
        DEFAULT: 'var(--fx-radius-control)',
        lg: 'var(--fx-radius-control)',
        md: 'var(--fx-radius-control)',
        sm: 'var(--fx-radius-control)',
        pill: 'var(--fx-radius-pill)',
      },
      fontFamily: {
        sans: ['var(--fx-type-ui-font-family)'],
        mono: ['var(--fx-type-code-font-family)'],
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
export default config;
