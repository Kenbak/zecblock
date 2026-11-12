// Applies the saved or system theme before first paint. Kept out of the page
// so the Content Security Policy can forbid every inline script.
(function () {
  try {
    var theme = localStorage.getItem('theme');
    if (!theme || !localStorage.getItem('theme-user-set')) theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.classList.add(theme === 'light' ? 'light' : 'dark');
  } catch (e) { document.documentElement.classList.add('dark'); }
})();
