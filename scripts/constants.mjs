export const MODULE_ID = "token-movement-fx";
export const DEFAULT_ACTION = "blink";
/** Time between the departure effect and the arrival effect, in milliseconds. */
export const TELEPORT_ARRIVAL_DELAY = 500;

/**
 * Whether an Automated Animations section should play. AA stores `enable` for
 * every section and turns the whole section into `false` when it is disabled,
 * so both forms must be treated as "off".
 * @param {object|false|null|undefined} section
 * @returns {boolean}
 */
export function sectionEnabled(section) {
  if (!section || section === true) return false;
  return section.enable !== false && section.enabled !== false;
}
