/** @type {import('tailwindcss').Config} */
export default {
  // 'class' (not the default 'media') so the toggle in useTheme.ts controls
  // dark mode directly — an OS-level dark preference alone shouldn't
  // override what the user explicitly picked in-app.
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};
