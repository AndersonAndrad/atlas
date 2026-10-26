/** Vite resolves imported SVG files to a URL (or an inlined data URI). */
declare module '*.svg' {
  const url: string;
  export default url;
}

/** Vite bundles `?worker` imports as a separate worker script (Monaco, SDD-011). */
declare module '*?worker' {
  const WorkerConstructor: new (options?: { name?: string }) => Worker;
  export default WorkerConstructor;
}
