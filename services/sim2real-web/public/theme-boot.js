/* Theme boot: resolve the theme before the stylesheets parse so the first
   paint already carries the right scheme (no white/dark flash). Must load
   synchronously, before app.js — app.js reads these globals at boot.
   The theme class lives on <html> only: every theme-dark CSS rule is scoped
   as "html.theme-dark <descendant>", so one class flip retints the app.
   Resolution order: stored preference, then OS preference, then dark. */
(function () {
  var KEY = 'rdk-lab-theme';
  function resolveTheme() {
    try {
      var stored = localStorage.getItem(KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch (error) {
      /* Storage unavailable (private mode): fall through to system. */
    }
    try {
      if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    } catch (error) {
      /* No matchMedia: default dark. */
    }
    return 'dark';
  }
  function applyTheme(theme) {
    document.documentElement.classList.toggle('theme-dark', theme === 'dark');
  }
  window.__rdkLabTheme = resolveTheme();
  window.__rdkApplyTheme = applyTheme;
  applyTheme(window.__rdkLabTheme);
})();
