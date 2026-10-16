import * as stylex from "@stylexjs/stylex";

// desk's colours (desk/static/desk.css): dark by default, light when the system is. Pinning a theme from the
// sidebar, as the old pages do, comes when the sidebar moves here.
const LIGHT = "@media (prefers-color-scheme: light)";

export const colors = stylex.defineVars({
  bg: { default: "lch(5.52% 0.4 272)", [LIGHT]: "lch(97.94% 0.5 282)" },
  border: { default: "lch(9.84% 1.48 272)", [LIGHT]: "lch(95.24% 0 282)" },
  text1: { default: "lch(100% 0 272)", [LIGHT]: "lch(9.794% 0 282)" },
  text2: { default: "lch(90.451% 1.2 272)", [LIGHT]: "lch(19.588% 1.25 282)" },
  text3: { default: "lch(61.803% 1.2 272)", [LIGHT]: "lch(39.176% 1.25 282)" },
  live: { default: "#4cb782", [LIGHT]: "lch(68% 64.37 141.95)" },
});
