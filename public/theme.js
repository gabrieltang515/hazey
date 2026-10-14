// Runs before first paint so a saved theme choice never flashes the other theme.
try {
  const theme = localStorage.getItem("hazey-theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch { /* Storage can be unavailable; the system theme still applies. */ }
