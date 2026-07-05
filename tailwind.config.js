/** @type {import('tailwindcss').Config} */
// Tailwind now compiles through PostCSS (was the cdn.tailwindcss.com Play CDN). `content` lists every
// file the JIT scans for class names; the app keeps colors/fonts in inline `style` + the `C` design
// tokens, so no theme extension or safelist is needed.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  // Dark mode keys off the same [data-theme] attribute the useTheme hook sets on <html>.
  // Existing utilities are dark-adapted centrally by the compat layer in src/index.css;
  // `dark:` variants are available for new code.
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: { extend: {} },
  plugins: [],
};
