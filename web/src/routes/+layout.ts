// The engine is a WebAssembly module that only exists in the browser, and the
// schematic lives entirely in client state, so there is nothing to render on a
// server. Prerender the shell and hand off.
export const prerender = true;
export const ssr = false;
