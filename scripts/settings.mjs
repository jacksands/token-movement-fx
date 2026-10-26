import { DEFAULT_ACTION, MODULE_ID, sectionEnabled } from "./constants.mjs";
import { getLegacyMappings } from "./legacy.mjs";

/**
 * Whether the Automated Animations module is active.
 * @returns {boolean}
 */
export function isAAActive() {
  return !!game.modules.get("autoanimations")?.active;
}

/**
 * Whether the Sequencer module is active.
 * @returns {boolean}
 */
export function isSequencerActive() {
  return !!game.modules.get("sequencer")?.active;
}

/**
 * The raw mapping settings, indexed by movement action id.
 * Missing values are merged from the legacy per-key settings so a world
 * created with an older version of the module keeps its choices.
 * @returns {Record<string, {enabled?: boolean, animationId?: string, hide?: boolean}>}
 */
export function getMappings() {
  const raw = game.settings.get(MODULE_ID, "mappings");
  const mappings = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  // Worlds saved by an older build may still hold the choice in separate
  // settings; merge anything the new object does not contain yet.
  for (const [actionId, legacy] of Object.entries(getLegacyMappings())) {
    if (!mappings[actionId] && legacy?.animationId) mappings[actionId] = legacy;
  }
  return mappings;
}

/** Raw Automated Animations setting, or null when it cannot be read. */
function readAASetting(key) {
  try {
    const value = game.settings.get("autoanimations", key);
    return value ?? null;
  } catch {
    return null;
  }
}

/** Automated Animations stores menus as arrays, but very old worlds as objects. */
function toEntryList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value).filter(Boolean);
  return [];
}

/**
 * Where to read one Automated Animations menu. "preset" is a top-level setting;
 * every other menu lives under "aaAutorec-<menu>".
 * @param {string} menu
 * @returns {string}
 */
function menuSettingKey(menu) {
  return menu === "preset" ? "aaAutorec-preset" : `aaAutorec-${menu}`;
}

/**
 * Every Automated Animations menu key, in the order its own manager uses.
 * @type {string[]}
 */
export const AA_MENUS = ["melee", "range", "ontoken", "templatefx", "aura", "preset", "aefx"];

/**
 * All Automated Animations menu entries, read live from the module's own
 * manager when available (it is the only public surface) and falling back to
 * the raw world settings. Nothing is cached: edits made in the AA editor are
 * visible the next time the list is opened or refreshed.
 * @returns {{menu: string, entry: object}[]}
 */
export function getAAEntries() {
  if (!isAAActive()) return [];

  const manager = globalThis.AutomatedAnimations?.AutorecManager;
  let menus = null;
  try {
    if (typeof manager?.getAutorecEntries === "function") menus = manager.getAutorecEntries();
  } catch {
    menus = null;
  }

  const found = [];
  for (const menu of AA_MENUS) {
    // Every menu is also read directly: a manager that only returns some of
    // them (or an older AA build) must not hide an entry from the list.
    const fromManager = menus && menu in menus ? toEntryList(menus[menu]) : [];
    const fromSettings = toEntryList(readAASetting(menuSettingKey(menu)));
    const seen = new Set();
    for (const entry of [...fromManager, ...fromSettings]) {
      if (!entry || (entry.id && seen.has(entry.id))) continue;
      if (entry.id) seen.add(entry.id);
      found.push({ menu, entry });
    }
  }
  return found;
}

/**
 * Finds one Automated Animations entry by id, in any menu.
 * @param {string} id
 * @returns {{menu: string, entry: object}|null}
 */
export function findAAEntryById(id) {
  if (typeof id !== "string" || !id) return null;
  return getAAEntries().find(candidate => candidate.entry?.id === id) ?? null;
}

/**
 * The effective configuration for one movement action. Per-token overrides
 * (stored in the token's flags) are merged over the global settings, so a token
 * can use its own animation, hide, or removePersistent for a given action.
 * @param {string} actionId
 * @param {TokenDocument|null} [tokenDoc] When provided, merges that token's overrides.
 * @returns {{enabled: boolean, animationId: string, hide: boolean, removePersistent: boolean}}
 */
export function getActionConfig(actionId, tokenDoc = null) {
  const stored = getMappings()[actionId] ?? {};
  const override = tokenDoc ? (getTokenOverrides(tokenDoc)?.[actionId] ?? null) : null;
  // A token override only applies when that token explicitly dedicates the
  // action (the "Use dedicated animation" checkbox); otherwise follow global.
  const merged = override?.dedicated ? { ...stored, ...override } : stored;
  const isDefault = actionId === DEFAULT_ACTION;
  const action = globalThis.CONFIG?.Token?.movement?.actions?.[actionId];
  const isTeleport = !!action?.teleport;
  return {
    enabled: merged.enabled ?? isDefault,
    animationId: typeof merged.animationId === "string" ? merged.animationId : "",
    // Teleport hides by default, but the GM can uncheck it to test the
    // animation without the module hiding the token. Other actions opt in.
    hide: merged.hide ?? isTeleport,
    // Remove persistent Sequencer effects created by this movement, once it
    // ends. Off by default; only meaningful for persistent On Token animations.
    removePersistent: !!merged.removePersistent
  };
}

/** Flag keys used to store per-token overrides on a TokenDocument. */
const FLAG_OVERRIDES = "overrides";
const FLAG_ENABLED = "enabled";

/**
 * Per-token per-action overrides, or null when the token has none.
 * @param {TokenDocument|null} tokenDoc
 * @returns {Record<string, object>|null}
 */
export function getTokenOverrides(tokenDoc) {
  if (!tokenDoc) return null;
  try {
    const value = tokenDoc.getFlag(MODULE_ID, FLAG_OVERRIDES);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Persist per-token per-action overrides. An empty object clears the flag.
 * @param {TokenDocument} tokenDoc
 * @param {Record<string, object>} overrides
 */
export async function setTokenOverrides(tokenDoc, overrides) {
  if (!tokenDoc) return;
  try {
    if (overrides && Object.keys(overrides).length) {
      await tokenDoc.setFlag(MODULE_ID, FLAG_OVERRIDES, overrides);
    } else {
      await tokenDoc.unsetFlag(MODULE_ID, FLAG_OVERRIDES);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | Could not save token overrides`, err);
  }
}

/**
 * Whether animations are enabled for a token. The master switch defaults to
 * true (inherit the global settings); a specific token can turn it off.
 * @param {TokenDocument|null} tokenDoc
 * @returns {boolean}
 */
export function isTokenEnabled(tokenDoc) {
  if (!tokenDoc) return true;
  try {
    const value = tokenDoc.getFlag(MODULE_ID, FLAG_ENABLED);
    return value === undefined ? true : !!value;
  } catch {
    return true;
  }
}

/**
 * Set the master enable/disable switch for a token.
 * @param {TokenDocument} tokenDoc
 * @param {boolean} enabled
 */
export async function setTokenEnabled(tokenDoc, enabled) {
  if (!tokenDoc) return;
  try {
    await tokenDoc.setFlag(MODULE_ID, FLAG_ENABLED, !!enabled);
  } catch (err) {
    console.error(`${MODULE_ID} | Could not save token enable flag`, err);
  }
}

/**
 * A human-readable label for an Automated Animations global menu entry.
 * @param {object} entry
 * @returns {string}
 */
export function getEntryLabel(entry) {
  const raw = entry?.label || entry?.name || "";
  if (!raw) return game.i18n.localize("TMFX.Settings.Unnamed");

  if (typeof raw === "string") {
    // Automated Animations stores bare keys such as "mistystep" for its
    // default presets, while its localization file uses the full key.
    const candidates = [
      raw,
      `autoanimations.animations.${raw}`,
      `autoanimations.presetTypes.${raw}`
    ];
    for (const key of candidates) {
      const localized = game.i18n.localize(key);
      if (localized && localized !== key) return localized;
    }
  }

  const pretty = String(raw)
    .split(".")
    .pop()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : String(raw);
}

/**
 * Finds a global Automated Animations "On Token" entry by id.
 * @param {string} id
 * @returns {object|null}
 */
export function getAAEntry(id) {
  if (!isAAActive()) return null;
  try {
    const match = findAAEntryById(id);
    if (!match) return null;
    const { entry, menu } = match;
    if (entry.killAnim || entry.isEnabled === false) return null;
    // The AA editor offers its own default entries (Cure Wounds, etc.) but
    // those live in menus this module should not replay on movement.
    if (entry.metaData?.default && menu !== "preset") return null;
    return entry;
  } catch {
    return null;
  }
}

/**
 * Resolve the Automated Animations flags behind an animation reference.
 * World Items are resolved synchronously so the movement hook can decide
 * whether to hide the token before the movement animation finishes.
 * @param {string} ref
 * @returns {object|null}
 */
export function getAnimationFlags(ref) {
  if (!isAAActive() || typeof ref !== "string") return null;
  try {
    if (ref.startsWith("global:")) return getAAEntry(ref.slice(7));
    if (ref.startsWith("item:")) {
      const item = globalThis.fromUuidSync?.(ref.slice(5));
      return item?.flags?.autoanimations ?? null;
    }
  } catch {
    // An unloaded compendium Item or a stale UUID cannot be inspected here.
  }
  return null;
}

/**
 * Whether the selected animation has a separate target/arrival section.
 * @param {string} ref
 * @returns {boolean}
 */
export function hasTargetSection(ref) {
  const flags = getAnimationFlags(ref);
  return !!(flags?.target?.video && sectionEnabled(flags.target));
}

/**
 * Finds an Automated Animations preset by reference.
 * Default presets get a stable reference because their generated ids change
 * whenever the world is reloaded: "preset:default:<label>".
 * Custom presets use "preset:<id>".
 * @param {string} ref
 * @returns {object|null}
 */
export function getAAPreset(ref) {
  if (!isAAActive() || typeof ref !== "string" || !ref.startsWith("preset:")) return null;
  try {
    const entries = toEntryList(readAASetting("aaAutorec-preset"));

    let entry;
    if (ref.startsWith("preset:default:")) {
      const label = ref.slice("preset:default:".length);
      entry = entries.find(candidate => candidate?.metaData?.default
        && (candidate.label === label || getEntryLabel(candidate) === label));
    } else {
      const id = ref.slice("preset:".length);
      entry = entries.find(candidate => candidate?.id === id);
    }

    if (!entry || entry.killAnim || entry.isEnabled === false) return null;
    if (entry.menu && entry.menu !== "preset") return null;
    // Teleport presets are accepted for non-teleport actions too (e.g. burrow),
    // as long as that action delegates to AA.
    if (entry.presetType !== "teleportation") return null;
    return entry;
  } catch {
    return null;
  }
}

/**
 * Teleportation presets from the Automated Animations Preset menu.
 * @returns {{value: string, label: string, kind: string}[]}
 */
export function getAAPresetOptions() {
  if (!isAAActive()) return [];

  const options = [];
  try {
    const entries = toEntryList(readAASetting("aaAutorec-preset"));
    for (const entry of entries) {
      if (!entry || entry.killAnim || entry.isEnabled === false) continue;
      if (entry.menu && entry.menu !== "preset") continue;
      // Teleport presets are offered for every selectable action. Actions that
      // are not teleport-like (burrow, walk, ...) replay the preset normally,
      // while teleport-like actions and burrow delegate it to AA.
      if (entry.presetType !== "teleportation") continue;

      const isDefault = !!entry.metaData?.default;
      const value = isDefault
        ? `preset:default:${entry.label ?? getEntryLabel(entry)}`
        : `preset:${entry.id}`;

      options.push({
        value,
        label: `Preset — ${getEntryLabel(entry)}`,
        kind: "preset",
        group: "preset",
        search: `preset ${getEntryLabel(entry)} ${entry.id ?? ""}`.toLowerCase()
      });
    }
  } catch {
    // Automated Animations is not initialized yet.
  }
  options.sort((a, b) => a.label.localeCompare(b.label));
  return options;
}

/**
 * All selectable animation sources: world Items configured through the A-A button,
 * entries from Automated Animations' Global Menu (On Token), and teleportation presets.
 * @returns {{value: string, label: string, kind: string, group: string, search: string}[]}
 */
export function getAAOptions() {
  if (!isAAActive()) return [];

  const options = [];
  for (const item of game.items?.contents ?? []) {
    const flags = item.flags?.autoanimations;
    if (!flags || flags.isEnabled === false || flags.killAnim) continue;
    if (flags.menu !== "ontoken") continue;
    const targetOnly = flags.primary?.options?.playOn === "target" ? " (Target)" : "";
    options.push({
      value: `item:${item.uuid}`,
      label: `Item — ${item.name}${targetOnly}`,
      kind: "item",
      group: "item"
    });
  }

  // Scan every AA menu through its own manager. The AA editor can store an
  // animation in any menu (Active Effect, Range, Template, Aura...), and those
  // must still be selectable here.
  const seen = new Set();
  for (const { menu, entry } of getAAEntries()) {
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (entry.killAnim || entry.isEnabled === false) continue;
    // Presets come from getAAPresetOptions(), which also verifies presetType.
    if (menu === "preset") continue;
    if (entry.metaData?.default) continue;
    const isAefx = menu === "aefx";
    options.push({
      value: `global:${entry.id}`,
      label: `${isAefx ? "AEFX" : "On Token"} — ${getEntryLabel(entry)}`,
      kind: "global",
      group: "ontoken",
      search: `global on token ontoken aefx ${getEntryLabel(entry)} ${entry.id}`.toLowerCase()
    });
  }

  const presets = getAAPresetOptions();
  options.push(...presets);

  // One search string per option: the visible label, the underlying AA name/id,
  // and the group words the user may type ("on token", "preset", "item").
  for (const option of options) {
    if (!option.search) option.search = option.label.toLowerCase();
  }
  options.sort((a, b) => a.label.localeCompare(b.label));
  return options;
}
