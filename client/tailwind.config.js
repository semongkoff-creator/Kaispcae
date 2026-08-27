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
        // Login page restyle (Figma kxCY7H7D8ZHzGkMCBDA2Y8, node 4:8) —
        // pulled verbatim from get_design_context's token list ("Text Slate
        // Color/*") plus the one accent hex used on the button/links.
        // Scoped to LoginPage.tsx only, same additive posture as `ethereal`.
        login: {
          accent: '#717BD8',
          'text-strong': '#323A46', // Text Slate Color/90 — field labels
          'text-muted': '#7E8B9E', // Text Slate Color/50 — helper/body copy
          'text-placeholder': '#CBD1D8', // Text Slate Color/20 — placeholders + input borders
          'border-soft': '#E0E3E8', // Text Slate Color/10 — Google button border
          surface: '#FAFAFC', // input field background
        },
      },
      // Opt-in via `font-ethereal` — NOT applied to `font-sans`/body, so the
      // rest of the app (login, lobby, admin, editor) keeps its current
      // system-ui look untouched. Only meeting-view components reach for
      // this class.
      fontFamily: {
        ethereal: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Login page restyle (Figma kxCY7H7D8ZHzGkMCBDA2Y8, node 4:8) — same
        // opt-in posture as `ethereal` above, scoped to LoginPage.tsx only.
        // `login-heading` (Poppins) for the "Welcome to KaiSpace" title,
        // `login-body` (Inter) for everything else on that screen — separate
        // names so a class typo can't silently fall back to the other family.
        'login-heading': ['Poppins', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        'login-body': ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      // The one non-stock radius Figma's login card/fields/buttons all share.
      borderRadius: {
        login: '6.361px',
      },
    },
  },
  plugins: [],
};
