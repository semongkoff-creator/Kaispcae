/** @type {import('tailwindcss').Config} */
export default {
  // 'class' (not the default 'media') so the toggle in useTheme.ts controls
  // dark mode directly — an OS-level dark preference alone shouldn't
  // override what the user explicitly picked in-app.
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // "Ethereal Collaboration" design tokens (Stitch reference) — a new,
      // additive namespace, not a redefinition of purple-*/gray-*/etc. Those
      // stock Tailwind shades already ARE this app's accent palette (418
      // existing purple-* usages across 74 files), so only the two values
      // that don't already have an exact stock match get named tokens here.
      // Everything else in the meeting UI restyle reuses purple-600/500/200,
      // gray-900/800, red-500, amber-400 directly.
      colors: {
        ethereal: {
          'primary-light': '#ddb8ff',
          text: '#e1e2e4',
        },
      },
      // Opt-in via `font-ethereal` — NOT applied to `font-sans`/body, so the
      // rest of the app (login, lobby, admin, editor) keeps its current
      // system-ui look untouched. Only meeting-view components reach for
      // this class.
      fontFamily: {
        ethereal: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
