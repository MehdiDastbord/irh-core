import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#05070f',
          900: '#070a15',
          850: '#0a0f1f',
          800: '#0d1426',
          700: '#131c33',
          600: '#1b2642',
        },
        brand: {
          50: '#eef2ff',
          100: '#dbe4ff',
          200: '#c3d0ff',
          300: '#9fb4ff',
          400: '#7e9bff',
          500: '#5b7cfa',
          600: '#4459e8',
          700: '#3a46c4',
        },
        accent: {
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(126,155,255,0.16), 0 18px 48px -24px rgba(91,124,250,0.55)',
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, #5b7cfa 0%, #8b5cf6 100%)',
        'panel-gradient': 'radial-gradient(1200px 600px at 80% -10%, rgba(91,124,250,0.18), transparent 60%), radial-gradient(900px 500px at 10% 10%, rgba(139,92,246,0.12), transparent 55%)',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-400px 0' },
          '100%': { backgroundPosition: '400px 0' },
        },
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s linear infinite',
        fadeIn: 'fadeIn 0.25s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
