export const VIEW_MODE_KEY = "spartan-live-view-mode";
export const VIEW_PC = "pc";
export const VIEW_MOBILE = "mobile";

export function cleanViewMode(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === VIEW_MOBILE) return VIEW_MOBILE;
  if (text === VIEW_PC) return VIEW_PC;
  return "";
}

export function readViewMode(storage) {
  try {
    return cleanViewMode(storage?.getItem?.(VIEW_MODE_KEY) || "");
  } catch {
    return "";
  }
}

export function rememberViewMode(storage, value) {
  const mode = cleanViewMode(value);
  if (!mode) return "";
  try {
    storage?.setItem?.(VIEW_MODE_KEY, mode);
  } catch {
    /* sem armazenamento */
  }
  return mode;
}

export function viewModeLabel(current) {
  return cleanViewMode(current) === VIEW_MOBILE ? "Modo PC" : "Modo Mobile";
}

export function nextViewMode(current) {
  return cleanViewMode(current) === VIEW_MOBILE ? VIEW_PC : VIEW_MOBILE;
}
