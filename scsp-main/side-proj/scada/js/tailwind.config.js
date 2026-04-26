/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        status: {
          pass: '#22c55e',
          warn: '#eab308',
          critical: '#ef4444',
        },
        reactor: {
          1: '#3b82f6',
          2: '#8b5cf6',
          3: '#06b6d4',
          4: '#f97316',
        }
      },
      animation: {
        'pulse-critical': 'pulse-critical 1.5s ease-in-out infinite',
      },
      keyframes: {
        'pulse-critical': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        }
      }
    },
  },
  plugins: [],
}
