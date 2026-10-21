// Applies the saved colour theme before first paint (kept tiny; app.js does the rest).
try {
  const saved = localStorage.getItem('payonproof-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  // Storage can be unavailable (private mode); the system theme is used.
}
