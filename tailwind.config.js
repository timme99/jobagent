/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          purple: '#30003b',
          dark:   '#1a0024',
          cyan:   '#11ccf5',
          light:  '#f5e6ff',
        },
      },
      fontFamily: {
        heading: ['Norwester', 'Impact', 'Arial Narrow', 'sans-serif'],
        body:    ['DM Sans', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
