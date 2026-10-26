import { MODULE_ID } from "./constants.mjs";

/**
 * Older builds of this module registered one setting per movement action
 * instead of the single "mappings" object. Worlds created with those builds
 * keep their choices under those keys, which is why the settings table showed
 * "None" while the play button still used the old animation.
 *
 * We scan the registered settings (not hardcoded names) for values that look
 * like animation references and convert them to the current shape.
 */

/** Every setting key this module registered in the current client. */
function registeredKeys() {
  const keys = new Set();
  try {
    const registry = game.settings?.settings;
    const iterable = registry?.keys ? registry.keys() : Object.keys(registry ?? {});
    for (const key of iterable ?? []) {
      const [namespace, ...rest] = String(key).split(".");
      if (namespace === MODULE_ID) keys.add(rest.join("."));
    }
  } catch {
    // The registry is unavailable; nothing to scan.
  }
  return keys;
}

/** Reads one of our settings defensively. */
function readSetting(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return undefined;
  }
}

/**
 * Collects legacy per-action mappings, ignoring anything already in the
 * current "mappings" object.
 * @returns {Record<string, {enabled?: boolean, animationId: string, hide?: boolean}>}
 */
export function getLegacyMappings() {
  const actionIds = Object.keys(globalThis.CONFIG?.Token?.movement?.actions ?? {});
  if (!actionIds.length) return {};

  const result = {};
  for (const key of registeredKeys()) {
    if (key === "mappings" || key === "enabled") continue;
    const value = readSetting(key);
    if (typeof value !== "string" || !/^(preset|global|item):/.test(value)) continue;
    const actionId = actionIds.find(id => key.startsWith(id));
    if (actionId) result[actionId] = { animationId: value };
  }
  return result;
}
