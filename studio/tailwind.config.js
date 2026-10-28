/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#08090B',
          900: '#0A0B0D',
          800: '#0E1013',
          700: '#121418',
          600: '#171A1F',
          500: '#1C2026',
        },
        accent: {
          DEFAULT: '#E8B15C',
          soft: '#F4CD8A',
          ink: '#1B1408',
        },
        danger: '#E57A6D',
        success: '#7CC79B',
      },
      fontFamily: {
        sans: ['Inter', 'SF Pro Text', '-apple-system', 'BlinkMacSystemFont', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['SFMono-Regular', 'JetBrains Mono', 'Consolas', 'Liberation Mono', 'monospace'],
      },
      borderRadius: {
        xl: '14px',
        '2xl': '18px',
        '3xl': '24px',
      },
      boxShadow: {
        panel: '0 24px 60px -36px rgba(0,0,0,.9)',
        lift: '0 18px 44px -26px rgba(0,0,0,.95)',
        glow: '0 0 0 1px rgba(232,177,92,.35), 0 10px 34px -16px rgba(232,177,92,.35)',
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'none' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': { from: { opacity: '0', transform: 'translate(-50%, -48%) scale(.97)' }, to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' } },
        'slide-in': { from: { transform: 'translateX(24px)', opacity: '0' }, to: { transform: 'none', opacity: '1' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        pulseSoft: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.45' } },
      },
      animation: {
        'fade-up': 'fade-up .35s cubic-bezier(.2,.8,.2,1) both',
        'fade-in': 'fade-in .2s ease-out both',
        'scale-in': 'scale-in .2s cubic-bezier(.2,.8,.2,1) both',
        'slide-in': 'slide-in .28s cubic-bezier(.2,.8,.2,1) both',
        shimmer: 'shimmer 1.6s infinite',
        'pulse-soft': 'pulseSoft 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
