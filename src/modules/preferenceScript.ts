/** Native preference bindings own settings; no demo table or side effects. */
export async function registerPrefsScripts(_window: Window): Promise<void> {
  const status = _window.document.getElementById("metadata-privacy");
  status?.setAttribute("role", "note");
}
