// The only browser-specific line: Firefox exposes `browser` (promise based), Chrome `chrome`
// (promise based in Manifest V3).
export const ext = globalThis.browser ?? globalThis.chrome;
