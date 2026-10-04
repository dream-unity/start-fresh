// Public backend origin; credentials are never included here.
// Same-origin hosting uses its own function. GitHub Pages uses the owner backend.
export const PUBLIC_API_BASE = globalThis.location?.hostname === 'dream-unity.github.io'
  ? 'https://dream-unity-start-fresh.vercel.app' : '';
