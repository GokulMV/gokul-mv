/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void: '#040508',
        ink: '#0A0D14',
        glacier: '#CFE8FF',
        summit: '#F4C77B',
        beacon: '#5EEAD4',
        ember: '#FB7185',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        hud: '0.28em',
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
};
