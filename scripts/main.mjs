import { MODULE_ID, sectionEnabled } from "./constants.mjs";
import { MovementFxConfig } from "./config-app.mjs";
import {
  getAAPreset,
  getActionConfig,
  getMappings,
  hasTargetSection,
  isAAActive,
  isSequencerActive,
  isTokenEnabled
} from "./settings.mjs";
import { getPathPoints, playAAPresetAsTeleport, playMovementFx, resolveTeleportEndpoints } from "./fx.mjs";

const SETTING_ENABLED = "enabled";
const SETTING_MAPPINGS = "mappings";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);

  game.settings.register(MODULE_ID, SETTING_ENABLED, {
    name: "TMFX.Settings.EnableName",
    hint: "TMFX.Settings.EnableHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTING_MAPPINGS, {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.registerMenu(MODULE_ID, "config", {
    name: "TMFX.Settings.MenuName",
    label: "TMFX.Settings.MenuLabel",
    hint: "TMFX.Settings.MenuHint",
    icon: "fa-solid fa-person-from-portal",
    type: MovementFxConfig,
    restricted: true
  });

  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      play: playMovementFx,
      getMappings,
      getActionConfig
    };
  }
});

Hooks.once("ready", () => {
  if (!game.modules.get("sequencer")?.active) {
    ui.notifications.warn(game.i18n.localize("TMFX.Notifications.NoSequencer"));
    return;
  }
  Hooks.on("preMoveToken", onPreMoveToken);
  Hooks.on("moveToken", onMoveToken);
  Hooks.on("renderTokenHUD", onRenderTokenHUD);
  game.socket?.on?.(SOCKET_CHANNEL, onSocketMessage);
});

const pendingTimers = new Map();
const generations = new Map();

/** Tokens whose movement is currently owned by Automated Animations. */
const delegationGuards = new Map();

/** Deduplicates a delegated movement that arrives locally and through the socket. */
const delegatedMovements = new Map();

/** Tokens being returned to their departure point without triggering effects. */
const repositioning = new Set();

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A stable key for per-token state. */
function tokenKey(tokenDoc) {
  return `${tokenDoc.parent?.id ?? "scene"}:${tokenDoc.id}`;
}

/** Whether two top-left positions are effectively identical. */
function samePoint(a, b) {
  if (!a || !b) return false;
  return Math.abs(Number(a.x) - Number(b.x)) < 0.5
    && Math.abs(Number(a.y) - Number(b.y)) < 0.5;
}

/**
 * Intercept teleport/burrow movement before Foundry commits it. When the
 * selected animation is an Automated Animations teleportation preset, the
 * module cancels the normal move and lets AA perform the whole teleport:
 * sound, departure/arrival animation, token fade, and the final document move.
 * @param {TokenDocument} tokenDoc
 * @param {TokenMovementOperation} movement
 * @returns {boolean|void} False cancels Foundry's movement.
 */
function onPreMoveToken(tokenDoc, movement) {
  if (!game.settings.get(MODULE_ID, SETTING_ENABLED)) return;
  if (!canvas.ready || canvas.scene?.id !== tokenDoc.parent?.id) return;
  // A token whose animations are turned off keeps Foundry's normal movement.
  if (!isTokenEnabled(tokenDoc)) return;

  const key = tokenKey(tokenDoc);

  // Internal repositioning back to the departure point is always allowed.
  if (repositioning.has(key)) return;

  // A guard belongs to a single delegated movement. Only the matching movement
  // may pass through it; a later move (even to the same square, e.g. walking
  // after a burrow) must be handled normally. The id is checked when available
  // so AA's own move is recognised on every client.
  const guard = delegationGuards.get(key);
  if (guard) {
    const sameMovement = !guard.movementId || !movement.id || guard.movementId === movement.id;
    if (guard.until > Date.now() && sameMovement) return;
    delegationGuards.delete(key);
  }

  // Automated Animations performs its final move through the API. That move
  // must always pass through, even if this client has not received the socket
  // guard yet. User drags/HUD/keyboard moves use "dragging"/"hud"/"keyboard".
  // Macro/API teleports intentionally keep Foundry's normal movement.
  if (movement.method === "api") return;

  // Build the whole path: origin plus every Ctrl+click checkpoint. Foundry
  // splits a waypoint drag into "passed" (the first checkpoint) and "pending"
  // (the remaining checkpoints), so both are read to recover A → B → C → D.
  const path = collectMovementPath(movement);
  if (path.length < 2) return;
  const origin = path[0];
  const destination = path.at(-1);

  const actionId = destination.action ?? movement.destination?.action;
  if (!actionId) return;

  const action = CONFIG.Token.movement.actions[actionId];
  if (!action) return;

  const config = getActionConfig(actionId, tokenDoc);
  const delegationPreset = config.animationId?.startsWith("preset:") === true;

  // The module mediates teleport-like actions and burrow, and any action whose
  // selected animation is an AA teleport preset (the preset itself moves the
  // token). Other actions keep Foundry's movement and post-move playback.
  if (!(actionId === "burrow" || action.teleport || delegationPreset)) return;

  if (typeof action.canSelect === "function") {
    try {
      if (!action.canSelect(tokenDoc)) return;
    } catch {
      // A system action that cannot evaluate this document should not block
      // movement handling.
    }
  }

  if (!config.enabled || !delegationPreset) return;

  const entry = getAAPreset(config.animationId);
  if (!entry) return;
  if (!sectionEnabled(entry.data?.start) && !sectionEnabled(entry.data?.end)) return;
  if (!isAAActive() || !isSequencerActive()) return;

  // AA's 3D preview uses a different target-selection flow; keep the normal
  // movement/replay path there instead of trying to capture a 2D pointer.
  if (game.Levels3DPreview?._active) return;

  const token = tokenDoc.object;
  if (!token) return;

  const pathWaypoints = path.slice(1, -1);
  const endpoints = resolveTeleportEndpoints(token, origin, destination, false, pathWaypoints);
  const movementId = movement.id ?? foundry.utils.randomID();
  const payload = {
    type: "delegate-preset",
    id: `${tokenDoc.parent.id}:${tokenDoc.id}:${movementId}`,
    sceneId: tokenDoc.parent.id,
    tokenId: tokenDoc.id,
    userId: game.user?.id ?? null,
    actionId,
    animationId: config.animationId,
    origin: {
      x: origin.x,
      y: origin.y,
      elevation: origin.elevation ?? 0,
      level: origin.level ?? tokenDoc.level
    },
    destination: {
      x: destination.x,
      y: destination.y,
      elevation: destination.elevation ?? 0,
      level: destination.level ?? tokenDoc.level
    },
    waypoints: pathWaypoints.map(point => ({
      x: point.x,
      y: point.y,
      elevation: point.elevation ?? 0,
      level: point.level ?? tokenDoc.level
    })),
    endpoints,
    createdAt: Date.now()
  };

  // Prevent the module's post-move playback when AA moves the token.
  delegationGuards.set(key, {
    until: Date.now() + 30000,
    destination: { x: destination.x, y: destination.y },
    movementId: `${tokenDoc.parent.id}:${tokenDoc.id}:${movementId}`
  });

  game.socket?.emit?.(SOCKET_CHANNEL, payload);
  handleDelegatedMovement(payload);

  // Cancel Foundry's movement. AA is now responsible for moving the token.
  return false;
}

/**
 * Play the delegated AA preset locally. Called on every client, either from
 * the local preMoveToken hook or from the module socket channel.
 * @param {object} payload
 */
async function handleDelegatedMovement(payload) {
  if (!payload || payload.type !== "delegate-preset" || !payload.id) return;
  if (delegatedMovements.has(payload.id)) return;
  delegatedMovements.set(payload.id, Date.now());
  setTimeout(() => delegatedMovements.delete(payload.id), 60000);

  const key = `${payload.sceneId}:${payload.tokenId}`;
  delegationGuards.set(key, {
    until: Date.now() + 30000,
    destination: { x: payload.destination.x, y: payload.destination.y },
    movementId: payload.id
  });

  // Let Foundry finish cancelling the original update before AA starts.
  await wait(0);

  const scene = game.scenes.get(payload.sceneId);
  if (!scene || canvas.scene?.id !== scene.id) return;

  const tokenDoc = scene.tokens.get(payload.tokenId);
  const token = tokenDoc?.object;
  if (!token) return;

  // Re-read the preset: a socket payload may arrive on a client that has not
  // finished registering the AA settings yet.
  const entry = getAAPreset(payload.animationId);
  if (!entry) return;

  const primary = isDelegationPrimary(tokenDoc, payload);

  // If an earlier drag segment already moved the token, put it back at the
  // original departure point before handing control to AA.
  if (Number(tokenDoc.x) !== Number(payload.origin.x)
    || Number(tokenDoc.y) !== Number(payload.origin.y)) {
    const alpha = token.alpha;
    token.alpha = 0;
    repositioning.add(key);
    try {
      await tokenDoc.move([{ x: payload.origin.x, y: payload.origin.y }], {
        animate: false,
        constrainOptions: { ignoreWalls: true, ignoreCost: true, ignoreTokens: true }
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not return token to its departure point`, err);
    } finally {
      repositioning.delete(key);
      if (!token.destroyed) token.alpha = alpha;
    }
  }

  const played = await playAAPresetAsTeleport(token, entry, payload.endpoints, {
    primary,
    destination: payload.destination,
    chain: getPathPoints(payload.endpoints)
  });
  if (!played && primary) {
    // AA could not start at all: finish the movement immediately, once. No
    // timer is scheduled, so nothing can move the token later on its own.
    try {
      const arrived = samePoint(tokenDoc, payload.destination);
      if (!arrived) {
        repositioning.add(key);
        await tokenDoc.move([{ x: payload.destination.x, y: payload.destination.y }], {
          animate: false,
          constrainOptions: { ignoreWalls: true, ignoreCost: true, ignoreTokens: true }
        });
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to complete delegated movement`, err);
    } finally {
      repositioning.delete(key);
      delegationGuards.delete(key);
    }
  }
}

/**
 * The whole path of one movement: the origin plus every explicit checkpoint
 * (a Ctrl+click waypoint). Foundry splits a waypoint drag into "passed" (the
 * first checkpoint) and "pending" (the remaining checkpoints) and fills the
 * gaps with intermediate cells; this returns only the checkpoints, in order.
 * @param {object} movement
 * @returns {object[]}
 */
function collectMovementPath(movement) {
  const points = [];
  const push = point => {
    if (!point || point.intermediate) return;
    if (points.length && samePoint(points.at(-1), point)) return;
    points.push(point);
  };
  push(movement.origin);
  for (const point of movement.passed?.waypoints ?? []) push(point);
  for (const point of movement.pending?.waypoints ?? []) push(point);
  return points;
}

/**
 * Choose a single client to perform AA's document move. Prefer the active GM
 * when it is viewing this scene, then the first active owner viewing the scene,
 * and finally the client that initiated the movement. Every client that can see
 * the scene still plays the animation locally.
 * @param {TokenDocument} tokenDoc
 * @param {{userId?: string}} [payload]
 * @returns {boolean}
 */
function isDelegationPrimary(tokenDoc, payload = {}) {
  const sceneId = tokenDoc.parent?.id;
  const users = Array.from(game.users ?? []);
  const viewers = users.filter(user => user.active
    && (user.isSelf || user.viewedScene === sceneId));

  // The active GM is the natural primary client, but only if it is actually
  // viewing this scene. A GM parked in another scene cannot play the effect or
  // move this token.
  const gm = game.users?.activeGM;
  if (gm && viewers.includes(gm)) return gm.isSelf;

  try {
    const owner = viewers.find(user => tokenDoc.canUserModify(user, "update"));
    if (owner) return owner.isSelf;
  } catch {
    // Fall through to the initiating client.
  }

  // The client that started the movement is guaranteed to be viewing the
  // scene and to have permission, so it is the safest fallback.
  if (payload.userId) return payload.userId === game.user?.id;
  return !!game.user?.isGM;
}

/** Receive a delegated movement from another client. */
function onSocketMessage(payload) {
  if (payload?.type !== "delegate-preset") return;
  // Ignore an echo of our own broadcast: the initiating client already started
  // the chain locally, and starting it twice is what made the token move again
  // and again without a new command.
  if (payload.userId && payload.userId === game.user?.id) return;
  handleDelegatedMovement(payload);
}

/**
 * React to a movement segment completing. The hook is called on every client,
 * so each client plays its own local Sequencer/AA effect.
 * @param {TokenDocument} tokenDoc
 * @param {TokenMovementOperation} movement
 */
function onMoveToken(tokenDoc, movement) {
  if (!game.settings.get(MODULE_ID, SETTING_ENABLED)) return;
  if (!canvas.ready || canvas.scene?.id !== tokenDoc.parent?.id) return;
  // A token whose animations are turned off keeps Foundry's normal movement.
  if (!isTokenEnabled(tokenDoc)) return;

  const key = tokenKey(tokenDoc);
  if (repositioning.has(key)) {
    repositioning.delete(key);
    return;
  }

  // Automated Animations owns this movement (teleport/burrow preset). Its own
  // document.move must not trigger the module's replay a second time.
  const guard = delegationGuards.get(key);
  if (guard) {
    if (guard.until > Date.now() && samePoint(movement.destination, guard.destination)) {
      delegationGuards.delete(key);
      return;
    }
    delegationGuards.delete(key);
  }

  // AA's own final move uses the API method. Do not replay the module effect
  // for it (and do not replay it for macro/API teleports either).
  if (movement.method === "api") return;

  // Wait until the token has no more queued waypoints.
  if (movement.pending?.waypoints?.length) return;

  const actionId = movement.destination?.action ?? movement.passed?.waypoints?.at(-1)?.action;
  if (!actionId) return;

  const config = getActionConfig(actionId, tokenDoc);
  if (!config.enabled) return;

  const action = CONFIG.Token.movement.actions[actionId];
  if (action && typeof action.canSelect === "function") {
    try {
      // Match the Token HUD: internal or unavailable actions (for example
      // core "displace") should not trigger a movement animation.
      if (!action.canSelect(tokenDoc)) return;
    } catch {
      // A system action that cannot evaluate this document should not block
      // movement handling; fall through to the normal playback checks.
    }
  }

  const isTeleport = !!action?.teleport;
  const hasAnimation = !!config.animationId;
  if (!hasAnimation) return;

  const generation = (generations.get(tokenDoc.id) ?? 0) + 1;
  generations.set(tokenDoc.id, generation);

  const previousTimer = pendingTimers.get(tokenDoc.id);
  if (previousTimer) clearTimeout(previousTimer);

  const path = collectMovementPath(movement);
  const origin = path[0] ?? null;
  const destination = path.at(-1) ?? null;
  const pathWaypoints = path.slice(1, -1);

  // Source-only animations are "On Token" effects: they follow the token, so
  // they play as soon as the movement begins instead of waiting for the arrival.
  const presetAnimation = config.animationId?.startsWith("preset:") === true;
  const sourceOnly = !!config.animationId
    && !presetAnimation
    && !hasTargetSection(config.animationId);
  const splitPlayback = isTeleport
    || presetAnimation
    || sourceOnly
    || hasTargetSection(config.animationId);
  if (splitPlayback && tokenDoc.object) {
    pendingTimers.delete(tokenDoc.id);
    if (!game.user.isGM && tokenDoc.hidden) return;

    playMovementFx(tokenDoc.object, actionId, config, {
      origin,
      destination,
      waypoints: pathWaypoints,
      movement,
      isCurrent: () => generations.get(tokenDoc.id) === generation
    }).catch(err => {
      console.error(`${MODULE_ID} | Failed to play movement effect`, err);
    });
    return;
  }

  const timer = setTimeout(async () => {
    pendingTimers.delete(tokenDoc.id);

    try {
      const current = tokenDoc.movement;
      const animatedMovement = current?.id === movement.id ? current : movement;
      const placeableAnimation = tokenDoc.object?.movementAnimationPromise;
      if (placeableAnimation) await placeableAnimation;
      else await animatedMovement.animation?.ended;
    } catch {
      // An animation interruption should not block the effect.
    }

    try {
      if (generations.get(tokenDoc.id) !== generation) return;

      const token = tokenDoc.object;
      if (!token) return;
      if (!game.user.isGM && tokenDoc.hidden) return;

      await playMovementFx(token, actionId, config, {
        origin,
        destination,
        waypoints: pathWaypoints,
        movement,
        isCurrent: () => generations.get(tokenDoc.id) === generation
      });
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to play movement effect`, err);
    }
  }, 75);

  pendingTimers.set(tokenDoc.id, timer);
}

/**
 * Add a shortcut to the movement-action palette of the Token HUD. The entry is
 * GM-only because the settings menu itself is restricted to GMs.
 * @param {TokenHUD} app
 * @param {HTMLElement} element
 */
function onRenderTokenHUD(app, element) {
  if (!game.user.isGM) return;

  const root = element instanceof HTMLElement ? element : element?.[0] ?? app?.element;
  const palette = root?.querySelector?.('.palette[data-palette="movementActions"]');
  if (!palette || palette.querySelector(".tmfx-config-entry")) return;

  // Per-token overrides: edits the selected token only.
  const tokenEntry = document.createElement("a");
  tokenEntry.className = "palette-list-entry tmfx-config-entry tmfx-token-entry";
  tokenEntry.dataset.tooltip = game.i18n.localize("TMFX.Settings.TokenTitle");
  tokenEntry.setAttribute("aria-label", game.i18n.localize("TMFX.Settings.TokenTitle"));
  tokenEntry.innerHTML = `<span><i class="fa-solid fa-user-gear fa-fw" inert></i>${game.i18n.localize("TMFX.Settings.TokenTitle")}</span>`;
  tokenEntry.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    const tokenDoc = app.object?.document;
    if (!tokenDoc) return;
    const existing = foundry.applications?.instances?.get("token-movement-fx-config-token");
    if (existing) {
      // The window is shared by all tokens: re-point it at the token that was
      // just opened, otherwise it would keep editing the previous token.
      existing.token = tokenDoc;
      existing.render({ force: true });
    } else {
      new MovementFxConfig({ token: tokenDoc }).render({ force: true });
    }
  });

  // Global settings: applies to every token.
  const entry = document.createElement("a");
  entry.className = "palette-list-entry tmfx-config-entry";
  entry.dataset.tooltip = game.i18n.localize("TMFX.Settings.MenuHint");
  entry.setAttribute("aria-label", game.i18n.localize("TMFX.Settings.UniversalLabel"));
  entry.innerHTML = `<span><i class="fa-solid fa-wand-magic-sparkles fa-fw" inert></i>${game.i18n.localize("TMFX.Settings.UniversalLabel")}</span>`;
  entry.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();

    const existing = foundry.applications?.instances?.get("token-movement-fx-config");
    if (existing) existing.render({ force: true });
    else new MovementFxConfig().render({ force: true });
  });

  palette.append(tokenEntry);
  palette.append(entry);
}
