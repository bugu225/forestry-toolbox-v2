const KEY_PREFIX = "ftb2_sync_meta_";

export function getSyncMeta(moduleName) {
  const raw = localStorage.getItem(`${KEY_PREFIX}${moduleName}`);
  if (!raw) {
    return { lastSuccessAt: "", lastError: "" };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      lastSuccessAt: parsed.lastSuccessAt || "",
      lastError: parsed.lastError || "",
    };
  } catch (_) {
    return { lastSuccessAt: "", lastError: "" };
  }
}

export function setSyncMeta(moduleName, patch) {
  const current = getSyncMeta(moduleName);
  const next = {
    ...current,
    ...patch,
  };
  localStorage.setItem(`${KEY_PREFIX}${moduleName}`, JSON.stringify(next));
  return next;
}
