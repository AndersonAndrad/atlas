/** Vite resolves imported SVG files to a URL (or an inlined data URI). */
declare module '*.svg' {
  const url: string;
  export default url;
}
