/** @type {import('tailwindcss').Config} */
// Tailwind now compiles through PostCSS (was the cdn.tailwindcss.com Play CDN). `content` lists every
// file the JIT scans for class names; the app keeps colors/fonts in inline `style` + the `C` design
// tokens, so no theme extension or safelist is needed.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {} },
  plugins: [],
};
