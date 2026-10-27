// Runs in <head> before the stylesheet paints, so the saved theme never flashes.
try {
  var t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* private mode: fall back to the system theme */ }
