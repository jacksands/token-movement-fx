import { MODULE_ID, TELEPORT_ARRIVAL_DELAY, sectionEnabled } from "./constants.mjs";
import { getAAEntry, getAAPreset, getAnimationFlags, getEntryLabel, isAAActive, isSequencerActive } from "./settings.mjs";

/**
 * Tokens currently hidden by an in-flight teleport. A counter is used so two
 * overlapping effects cannot reveal the token before both are done.
 * @type {Map<string, {count: number, alpha: number}>}
 */
const hiddenTokens = new Map();

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Coerce a value to a finite number, falling back when it is missing/invalid. */
const numberOr = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

/**
 * Play the configured animation for a movement action.
 * @param {Token} token                         The token at its destination.
 * @param {string} actionId                     Movement action id (blink, walk, ...).
 * @param {{enabled: boolean, animationId: string, hide?: boolean, removePersistent?: boolean}} config
 * @param {{
 *   test?: boolean,
 *   origin?: object|null,
 *   destination?: object|null,
 *   waypoints?: object[]|null,   Extra path points (Ctrl+click).
 *   movement?: object|null,
 *   isCurrent?: (() => boolean)|null
 * }} [options]
 * @returns {Promise<boolean>}                  Whether an animation was played.
 */
export async function playMovementFx(token, actionId, config, {
  test = false,
  origin = null,
  destination = null,
  waypoints = null,
  movement = null,
  isCurrent = null
} = {}) {
  if (!token || !config) return false;
  if (!config.enabled && !test) return false;

  const action = CONFIG.Token.movement.actions[actionId];
  if (!action) return false;

  const animationId = config.animationId ?? "";

  if (action.teleport) {
    if (!animationId) return false;

    const endpoints = resolveTeleportEndpoints(token, origin, destination, test, waypoints);
    // Teleport defaults to hiding between departure and arrival, but the GM
    // can disable it so the departure and arrival still play with the token
    // visible. Without an arrival section there is nothing to wait for, so the
    // token must not stay invisible.
    const needsHide = config.hide !== false;
    const hide = needsHide ? hideToken(token) : { release() {} };

    try {
      return await playTeleportRef(token, animationId, endpoints, {
        test,
        movement,
        hide,
        isCurrent
      });
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to play teleport animation`, err);
      return false;
    } finally {
      // Safety net: the effect releases the token at the arrival moment, but
      // an error or an interrupted animation must never leave it invisible.
      hide.release();
    }
  }

  if (!animationId) return false;

  const endpoints = resolveTeleportEndpoints(token, origin, destination, test, waypoints);
  const hide = config.hide ? hideToken(token) : { release() {} };

  try {
    // Presets keep their paired Start/End for any action.
    if (animationId.startsWith("preset:")) {
      const played = await playTeleportRef(token, animationId, endpoints, {
        test,
        movement,
        hide,
        isCurrent,
        defaultArrivalDelay: 0,
        requireBoth: false
      });
      if (played) return true;
    }

    // Departure + arrival for On Token / Item sources. The departure starts
    // immediately; the arrival waits for the token to reach the drop point.
    const flags = getAnimationFlags(animationId);
    const hasTarget = !!(flags?.target?.video && sectionEnabled(flags.target));
    if (hasTarget) {
      const played = await playTeleportAA(token, flags, endpoints, {
        movement,
        hide,
        isCurrent,
        defaultArrivalDelay: 0,
        requireBoth: false
      });
      if (played) return true;
    }

    // Source-only ("On Token") animations belong to the token, which is already
    // moving by now. Play them right away instead of waiting for the arrival.
    if (!hasTarget) {
      const before = config.removePersistent ? snapshotPersistentEffects() : null;
      try {
        return await playAnimationRef(token, animationId, endpoints.origin);
      } finally {
        if (before) {
          // Give AA/Sequencer a beat to register the persistent effect, then
          // remove only the ones this movement just created on this token.
          await waitForMovement(movement, token);
          await removeNewPersistentEffects(token, before);
        }
      }
    }
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to play movement animation`, err);
  } finally {
    hide.release();
  }

  return false;
}

/**
 * Resolve the departure and arrival centers of a teleport movement.
 * Movement waypoints store the token's top-left corner, while Sequencer
 * effects should be centered on the token.
 * @param {Token} token
 * @param {object|null} origin
 * @param {object|null} destination
 * @param {boolean} test
 * @param {object[]|null} [waypoints] Extra path points between origin and
 *   destination (from Ctrl+click waypoints), as token top-left positions.
 * @returns {{origin: object, destination: object, waypoints: object[]}}
 */
export function resolveTeleportEndpoints(token, origin, destination, test, waypoints = null) {
  const gridSize = canvas?.grid?.size ?? 100;
  const width = token.w ?? (token.document?.width ?? 1) * gridSize;
  const height = token.h ?? (token.document?.height ?? 1) * gridSize;
  const fallbackElevation = token.document?.elevation ?? 0;
  const fallbackLevel = token.document?.level ?? canvas?.level;

  const toCenter = point => ({
    x: (point.x ?? 0) + width / 2,
    y: (point.y ?? 0) + height / 2,
    elevation: point.elevation ?? fallbackElevation,
    level: point.level ?? fallbackLevel
  });

  if (!test && origin && destination) {
    const path = Array.isArray(waypoints) && waypoints.length
      ? waypoints.map(toCenter)
      : [];
    return {
      origin: toCenter(origin),
      destination: toCenter(destination),
      waypoints: path
    };
  }

  const center = token.center ?? {
    x: (token.x ?? 0) + width / 2,
    y: (token.y ?? 0) + height / 2
  };
  const point = {
    x: center.x,
    y: center.y,
    elevation: fallbackElevation,
    level: fallbackLevel
  };
  return { origin: point, destination: point, waypoints: [] };
}

/**
 * Ordered path of a teleport: departure, every intermediate waypoint, arrival.
 * @param {{origin: object, destination: object, waypoints?: object[]}} endpoints
 * @returns {object[]}
 */
export function getPathPoints(endpoints) {
  const middle = Array.isArray(endpoints?.waypoints) ? endpoints.waypoints : [];
  return [endpoints.origin, ...middle, endpoints.destination].filter(Boolean);
}

/**
 * Hide a token locally and return an idempotent release handle.
 * @param {Token} token
 * @returns {{release: () => void}}
 */
function hideToken(token) {
  if (!token) return { release() {} };

  let state = hiddenTokens.get(token.id);
  if (!state) {
    state = { count: 0, alpha: token.alpha ?? 1 };
    hiddenTokens.set(token.id, state);
  }
  state.count++;
  token.alpha = 0;

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;

      const current = hiddenTokens.get(token.id);
      if (!current) return;
      current.count--;
      if (current.count > 0) return;

      hiddenTokens.delete(token.id);
      if (!token.destroyed) token.alpha = current.alpha;
    }
  };
}

/**
 * Wait for the token's movement animation, with a safety timeout.
 * @param {object|null} movement
 * @param {Token} token
 */
async function waitForMovement(movement, token) {
  if (!movement) return;
  try {
    // The placeable's animation promise is created just after moveToken fires.
    await wait(75);
    const promise = token?.movementAnimationPromise ?? movement.animation?.ended;
    if (!promise) return;
    await Promise.race([promise, wait(2000)]);
  } catch {
    // An interrupted movement should not block the arrival effect.
  }
}

/**
 * Snapshot the ids of the persistent effects currently running on the canvas.
 * Only effects created after this snapshot and belonging to the moving token
 * will be removed later, so other persistent auras on the same token survive.
 * @returns {Set<string>}
 */
function snapshotPersistentEffects() {
  const effects = globalThis.Sequencer?.EffectManager?.effects;
  if (!effects) return new Set();
  return new Set(
    effects.filter(effect => effect?.data?.persist).map(effect => effect.id)
  );
}

/**
 * Remove the persistent effects created since the snapshot that belong to the
 * given token. Anything that already existed (or belongs to another source) is
 * left untouched.
 * @param {Token} token
 * @param {Set<string>} before
 */
async function removeNewPersistentEffects(token, before) {
  const manager = globalThis.Sequencer?.EffectManager;
  if (!manager?.effects || !manager?.endEffects) return;
  const tokenUuid = token?.document?.uuid;
  const created = manager.effects.filter(effect => {
    if (!effect?.data?.persist || !effect.id) return false;
    if (before.has(effect.id)) return false;
    return !tokenUuid || effect.data.source === tokenUuid;
  });
  if (!created.length) return;
  try {
    await manager.endEffects({ effects: created.map(effect => effect.id) });
  } catch (err) {
    console.warn(`${MODULE_ID} | Could not remove persistent effects`, err);
  }
}

/**
 * Play either an Item configured with Automated Animations or an On Token entry.
 * Source-only effects are anchored to `origin` so an "On Token" animation plays
 * where the movement began instead of following the token's new position.
 * @param {Token} token
 * @param {string} ref
 * @param {{x: number, y: number, elevation?: number, level?: string}|null} [origin]
 * @returns {Promise<boolean>}
 */
async function playAnimationRef(token, ref, origin = null) {
  if (!isAAActive()) return false;
  const api = globalThis.AutomatedAnimations;
  if (!api?.playAnimation) return false;

  try {
    let item;
    if (ref.startsWith("item:")) {
      try {
        item = await globalThis.fromUuid(ref.slice(5));
      } catch {
        item = null;
      }
      if (!item) return false;
    } else if (ref.startsWith("global:")) {
      const entry = getAAEntry(ref.slice(7));
      if (!entry) return false;
      // Pass a snapshot with a unique id. Automated Animations caches the last
      // playback per item uuid/id, so reusing the raw entry id would replay the
      // old flags after the entry is edited (or play a deleted animation).
      item = buildSyntheticItem(entry, `run-${foundry.utils.randomID(6)}`);
    } else {
      return false;
    }

    // Target-only animations need a target. The token itself is the target;
    // source effects are anchored to the origin so they do not jump to the
    // destination while the token is still moving.
    const flags = item.flags?.autoanimations;
    const isPersistent = !!flags?.primary?.options?.persistent;
    const targetOnly = flags?.primary?.options?.playOn === "target";
    // Persistent effects must bind to the real token so they follow it; the
    // fake origin token is only used to anchor non-persistent effects at the
    // departure point.
    const sourceToken = (isPersistent || !origin) ? token : buildOriginToken(token, origin);
    const handler = await api.playAnimation(targetOnly ? token : sourceToken, item, {
      targets: targetOnly ? [token] : []
    });
    if (!handler) return false;

    // If AA still compiled a target-only effect without a target, let the
    // caller fall back instead of reporting a playback that cannot be seen.
    if (handler.animationData?.primary?.options?.playOn === "target" && !targetOnly) return false;
    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to play Automated Animations effect`, err);
    return false;
  }
}

/**
 * Play the departure and arrival parts of a teleport animation.
 * @param {Token} token
 * @param {string} ref
 * @param {{origin: object, destination: object}} endpoints
 * @param {object} options
 * @returns {Promise<boolean>}
 */
async function playTeleportRef(token, ref, endpoints, options) {
  if (!isAAActive()) return false;
  const api = globalThis.AutomatedAnimations;
  if (!api?.playAnimation) return false;

  try {
    if (ref.startsWith("preset:")) {
      const entry = getAAPreset(ref);
      if (!entry) return false;
      return await playTeleportPreset(token, entry, endpoints, options);
    }

    let flags;
    if (ref.startsWith("item:")) {
      let item;
      try {
        item = await globalThis.fromUuid(ref.slice(5));
      } catch {
        item = null;
      }
      if (!item) return false;
      flags = item.flags?.autoanimations;
    } else if (ref.startsWith("global:")) {
      flags = getAAEntry(ref.slice(7));
    } else {
      return false;
    }

    if (!flags?.primary?.video) return false;
    return await playTeleportAA(token, flags, endpoints, options);
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to play teleport animation`, err);
    return false;
  }
}

/**
 * Play an Automated Animations teleportation preset (for example Misty Step)
 * from its departure and arrival video data.
 * @param {Token} token
 * @param {object} entry
 * @param {{origin: object, destination: object}} endpoints
 * @param {object} options
 * @returns {Promise<boolean>}
 */
async function playTeleportPreset(token, entry, endpoints, options) {
  if (!isSequencerActive()) return false;
  const SequenceClass = globalThis.Sequence;
  if (!SequenceClass) return false;

  const data = entry.data ?? {};
  // Each section is independent. The user may disable Start and End in the
  // preset editor and keep only Between (or only one of them), so never force
  // a disabled section to play and never require both to exist.
  const start = sectionEnabled(data.start) ? data.start : null;
  const end = sectionEnabled(data.end) ? data.end : null;
  if (!start && !end && !sectionEnabled(data.between)) {
    console.warn(`${MODULE_ID} | Preset has no Start, End or Between animation enabled.`);
    return false;
  }

  const database = globalThis.Sequencer?.Database;
  const startFile = start ? buildAAFile(start) : null;
  const endFile = end ? buildAAFile(end) : null;
  if (startFile && !(start.enableCustom && start.customPath)
    && database?.entryExists && !database.entryExists(startFile)) {
    console.warn(`${MODULE_ID} | Preset Start animation not found: ${startFile}; skipping it.`);
  }
  if (endFile && !(end.enableCustom && end.customPath)
    && database?.entryExists && !database.entryExists(endFile)) {
    console.warn(`${MODULE_ID} | Preset End animation not found: ${endFile}; skipping it.`);
  }

  // Presets may also configure a "Between" animation (for example a beam or
  // trail) and a sound. Both are stored outside the Start/End sections.
  let betweenFile = null;
  const between = sectionEnabled(data.between) ? data.between : null;
  if (between) {
    betweenFile = buildAAFile(between);
    const betweenIsCustom = !!(between.enableCustom && between.customPath);
    if (!betweenFile) {
      console.warn(`${MODULE_ID} | Preset Between animation is enabled but has no valid file; skipping it.`);
    } else if (!betweenIsCustom && database?.entryExists && !database.entryExists(betweenFile)) {
      console.warn(`${MODULE_ID} | Preset Between animation not found: ${betweenFile}; skipping it.`);
      betweenFile = null;
    }
  }

  const sound = data.sound?.a01 ?? data.sound;
  const arrivalDelay = Math.max(0, numberOr(end?.options?.delay, TELEPORT_ARRIVAL_DELAY));

  try {
    const seq = new SequenceClass({ moduleName: "Token Movement FX", softFail: false });

    addPresetSound(seq, sound);

    // The departure effect is played asynchronously so the sequence can reach
    // the arrival moment without waiting for the whole departure video.
    if (startFile) addPresetEffect(seq, startFile, start.options, endpoints.origin, token, "start").async();
    if (betweenFile) {
      // One trail per leg: with waypoints A→B→C→D the preset draws A→B, B→C
      // and C→D instead of a single straight line from A to D.
      const points = getPathPoints(endpoints);
      for (let i = 0; i < points.length - 1; i++) {
        addPresetBetweenEffect(seq, betweenFile, between.options, points[i], points[i + 1], token, i);
      }
    }

    seq.thenDo(async () => {
      await waitForMovement(options.movement, token);
    });
    if (arrivalDelay > 0) seq.wait(arrivalDelay);
    seq.thenDo(() => options.hide.release());
    if (endFile) addPresetEffect(seq, endFile, { ...end.options, delay: 0 }, endpoints.destination, token, "end");

    await seq.play();
    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to play teleport preset`, err);
    return false;
  }
}

/**
 * Hand a teleport/burrow movement to Automated Animations' own teleportation
 * handler. AA normally waits for the user to click inside its range circle;
 * this helper captures that click listener, removes the circle, and invokes it
 * with the mouse-release drop point. AA then owns the sound, departure/arrival
 * animations, token fade, and the actual document move.
 *
 * @param {Token} token
 * @param {object} entry                  Raw AA preset entry.
 * @param {{origin: object, destination: object}} endpoints
 * @param {{primary?: boolean}} [options]  Only the primary client may move the document.
 * @returns {Promise<boolean>}
 */
export async function playAAPresetAsTeleport(token, entry, endpoints, {
  primary = true,
  destination = null,
  chain = null
} = {}) {
  // A Ctrl+click waypoint path: play the preset once per leg, keeping the
  // Start animation at the first point and the End animation at the last.
  const path = Array.isArray(chain) && chain.length > 1
    ? chain
    : getPathPoints(endpoints);
  if (path.length > 2) {
    return playAAPresetChain(token, entry, endpoints, { primary, chain: path });
  }

  if (!token || !entry || !endpoints?.destination) return false;
  if (!isAAActive() || !isSequencerActive()) return false;

  const api = globalThis.AutomatedAnimations;
  if (!api?.playAnimation) return false;
  if (entry.menu && entry.menu !== "preset") return false;
  if (entry.presetType !== "teleportation") return false;

  const data = entry.data ?? {};
  if (!sectionEnabled(data.start) && !sectionEnabled(data.end) && !sectionEnabled(data.between)) {
    console.warn(`${MODULE_ID} | Preset "${getEntryLabel(entry)}" has no enabled section for delegated movement.`);
    return false;
  }

  const tokenDoc = token.document;
  if (!tokenDoc) return false;

  const stage = canvas?.app?.stage;
  if (!stage?.addListener) return false;

  // AA compiles the preset from the item flags. Keep the preset's normal range
  // so the temporary border is not enormous, but disable collision checks.
  // The range check itself is neutralised only while the drop point is injected.
  const item = buildSyntheticItem(entry, `delegate-${foundry.utils.randomID(6)}`);
  const flags = item.flags?.autoanimations;
  if (!flags?.data) return false;
  // A default preset may not carry a menu property in the setting. Force the
  // preset branch so AA compiles it with its teleportation handler.
  flags.menu = "preset";
  flags.presetType = "teleportation";
  // The preset entry is already in the current AA format. Skip flag migrations
  // so AA cannot rewrite the start/end sections while compiling the synthetic
  // item.
  flags.version = Math.max(Number(flags.version) || 0, 999);
  flags.data.options ??= {};
  flags.data.options.teleport = true;
  flags.data.options.checkCollision = false;

  // Only the primary client runs the preset macro. Every client still plays
  // the animation and sound, but a damage/healing macro must not run twice.
  // AA reads animationData.macro directly, so remove it instead of disabling it.
  if (!primary) delete flags.macro;

  const originalAdd = stage.addListener;
  const originalMeasure = canvas.grid.measurePath;
  const originalMove = tokenDoc.move;

  // AA moves the document to the top-left of the destination cell, while the
  // endpoints passed to the effect use the token's center.
  const destinationTopLeft = destination ?? {
    x: (endpoints.destination.x ?? 0) - (token.w ?? 0) / 2,
    y: (endpoints.destination.y ?? 0) - (token.h ?? 0) / 2
  };
  const isDelegatedMove = waypoints => {
    const point = Array.isArray(waypoints) ? waypoints.at(-1) : waypoints;
    return !!point
      && Math.abs(Number(point.x) - Number(destinationTopLeft.x)) < 0.5
      && Math.abs(Number(point.y) - Number(destinationTopLeft.y)) < 0.5;
  };
  // Only suppress AA's move to the delegated destination. A user who drags the
  // token somewhere else during the animation must still be able to move it.
  const noMove = async function(waypoints, options) {
    if (isDelegatedMove(waypoints)) return tokenDoc;
    return originalMove.call(tokenDoc, waypoints, options);
  };

  let pointerListener = null;
  let pointerListenerRaw = null;
  let resolveListener;
  const listenerReady = new Promise(resolve => {
    resolveListener = resolve;
  });
  let patchedMove = false;

  stage.addListener = function(event, fn, context) {
    const result = originalAdd.call(this, event, fn, context);
    if (event === "pointerdown" && !pointerListener) {
      pointerListenerRaw = fn;
      pointerListener = fn.bind(context ?? this);
      resolveListener();
    }
    return result;
  };

  // Every client plays AA locally for sound/animation. Only one client is
  // allowed to move the document, otherwise the token receives duplicate moves.
  if (!primary) {
    try {
      tokenDoc.move = noMove;
      patchedMove = tokenDoc.move === noMove;
    } catch {
      // If the method cannot be shadowed, duplicate moves are preferable to
      // losing the animation entirely.
    }
  }

  const fakeMeasurePath = function(...args) {
    const result = originalMeasure.apply(this, args);
    return { ...result, distance: 0 };
  };

  try {
    const handler = await api.playAnimation(token, item, { targets: [] });
    if (!handler) {
      console.warn(`${MODULE_ID} | Automated Animations did not compile the teleport preset.`);
      return false;
    }

    await Promise.race([listenerReady, wait(10000)]);
    if (!pointerListener) {
      console.warn(`${MODULE_ID} | Automated Animations did not open its teleport target listener.`);
      try {
        globalThis.Sequencer?.EffectManager?.endEffects({ name: "teleportation" });
      } catch {
        // Sequencer is already guarded above.
      }
      return false;
    }

    // The user does not choose a target inside AA's range circle; the movement
    // drop point is the target. Remove the temporary border immediately.
    try {
      globalThis.Sequencer?.EffectManager?.endEffects({ name: "teleportation" });
    } catch {
      // The border is cosmetic; never block the handoff because of it.
    }

    canvas.grid.measurePath = fakeMeasurePath;
    try {
      pointerListener({
        data: {
          button: 0,
          getLocalPosition: () => ({
            x: endpoints.destination.x,
            y: endpoints.destination.y,
            elevation: endpoints.destination.elevation ?? 0
          })
        }
      });
    } finally {
      canvas.grid.measurePath = originalMeasure;
    }

    // The border is created asynchronously by Sequencer; end it once more after
    // the current frame so no range circle is left behind.
    setTimeout(() => {
      try {
        globalThis.Sequencer?.EffectManager?.endEffects({ name: "teleportation" });
      } catch {
        // Cosmetic only.
      }
    }, 150);

    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to hand teleport movement to Automated Animations`, err);
    return false;
  } finally {
    stage.addListener = originalAdd;
    if (pointerListenerRaw) {
      try {
        stage.removeListener?.("pointerdown", pointerListenerRaw);
      } catch {
        // The listener may already have removed itself.
      }
    }
    if (patchedMove) {
      // AA schedules its document move after the sequence and delayMove. Keep
      // the no-op in place long enough to cover that window, then restore it.
      setTimeout(() => {
        if (tokenDoc.move === noMove) tokenDoc.move = originalMove;
      }, 30000);
    }
  }
}

/**
 * Hand a multi-waypoint teleport to Automated Animations as ONE sequence.
 *
 * The preset plays its Start animation at the first point, its Between trail
 * once per leg, and its End animation at the arrival point. The token is moved
 * to the last waypoint by the module itself, so every leg is drawn while the
 * token is invisible and there is no wait between animations.
 *
 * @param {Token} token
 * @param {object} entry                   Raw AA preset entry.
 * @param {{origin: object, destination: object, waypoints?: object[]}} endpoints
 * @param {{primary: boolean, chain: object[]}} options
 * @returns {Promise<boolean>}
 */
async function playAAPresetChain(token, entry, endpoints, { primary, chain }) {
  if (!isSequencerActive()) return false;
  const SequenceClass = globalThis.Sequence;
  if (!SequenceClass) return false;

  const tokenDoc = token.document;
  if (!tokenDoc) return false;

  const data = entry.data ?? {};
  const start = sectionEnabled(data.start) ? data.start : null;
  const end = sectionEnabled(data.end) ? data.end : null;
  const between = sectionEnabled(data.between) ? data.between : null;
  if (!start && !end && !between) {
    console.warn(`${MODULE_ID} | Preset "${getEntryLabel(entry)}" has no enabled section.`);
    return false;
  }

  const startFile = start ? buildAAFile(start) : null;
  const endFile = end ? buildAAFile(end) : null;
  const betweenFile = between ? buildAAFile(between) : null;

  const sound = data.sound?.a01 ?? data.sound;
  const last = chain.at(-1);
  const lastTopLeft = {
    x: (last.x ?? 0) - (token.w ?? 0) / 2,
    y: (last.y ?? 0) - (token.h ?? 0) / 2
  };

  // The token stays invisible for the whole journey: the token is moved only
  // after the last trail finishes, so nothing is revealed between legs.
  const chainHide = hideToken(token);
  try {
    const seq = new SequenceClass({ moduleName: "Token Movement FX", softFail: false });
    addPresetSound(seq, sound);

    if (startFile) {
      addPresetEffect(seq, startFile, start.options, chain[0], token, "start").async();
    }

    // One trail per leg, each waiting for the previous one to finish, so the
    // chain plays A → B, then B → C, then C → D instead of overlapping.
    if (betweenFile) {
      for (let i = 0; i < chain.length - 1; i++) {
        const leg = addPresetBetweenEffect(seq, betweenFile, between.options, chain[i], chain[i + 1], token, i);
        leg.waitUntilFinished?.();
      }
    }

    if (endFile) {
      addPresetEffect(seq, endFile, { ...end.options, delay: 0 }, chain.at(-1), token, "end");
    }

    // Move the document only when the sequence reaches the arrival.
    if (primary) {
      seq.thenDo(async () => {
        try {
          await tokenDoc.move([{ x: lastTopLeft.x, y: lastTopLeft.y }], {
            animate: false,
            constrainOptions: { ignoreWalls: true, ignoreCost: true, ignoreTokens: true }
          });
        } catch (err) {
          console.error(`${MODULE_ID} | Could not complete the waypoint teleport`, err);
        }
      });
    }

    await seq.play();
    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to play the waypoint teleport`, err);
    return false;
  } finally {
    // Reveal the token at the destination, never mid-path and never stranded.
    if (!token.destroyed) token.alpha = 1;
    chainHide.release();
  }
}

/**
 * Add the preset sound to a Sequencer sequence.
 * @param {Sequence} seq
 * @param {object} sound
 */
function addPresetSound(seq, sound) {
  if (!sound?.enable || !sound.file) return;
  if (typeof seq.sound !== "function") return;

  const section = seq.sound();
  section.file(sound.file);
  section.delay(numberOr(sound.delay, 0));
  section.startTime(numberOr(sound.startTime, 0));
  section.volume(numberOr(sound.volume, 1));
  section.repeats(numberOr(sound.repeat, 1), numberOr(sound.repeatDelay, 250));
}

/**
 * Add the optional "Between" preset animation for one leg of the path. Each
 * consecutive pair of waypoints gets its own trail, so a multi-waypoint
 * teleport draws A→B, B→C, C→D instead of a single straight line.
 * @param {Sequence} seq
 * @param {string} file
 * @param {object} opts
 * @param {{x: number, y: number, elevation: number, level: string}} origin
 * @param {{x: number, y: number, elevation: number, level: string}} destination
 * @param {Token} token
 * @param {number} [leg] Zero-based leg index, used to keep effect names unique.
 * @returns {EffectSection}
 */
function addPresetBetweenEffect(seq, file, opts = {}, origin, destination, token, leg = 0) {
  const elevation = numberOr(opts.elevation, 1000);
  const effect = seq.effect()
    .file(file)
    .atLocation({ x: origin.x, y: origin.y })
    .stretchTo({ x: destination.x, y: destination.y })
    .opacity(numberOr(opts.opacity, 1))
    .delay(numberOr(opts.delay, 0))
    .playbackRate(numberOr(opts.playbackRate, 1))
    .elevation(numberOr(origin.elevation, 0), { absolute: true })
    .onLevels(origin.level ?? canvas?.level)
    .name(`movement-fx-${token.id}-between-${leg}`);

  if (elevation === 0) effect.belowTokens(true);
  return effect;
}

/**
 * Add one preset effect to a Sequencer sequence.
 * @param {Sequence} seq
 * @param {string} file
 * @param {object} opts
 * @param {{x: number, y: number, elevation: number, level: string}} point
 * @param {Token} token
 * @param {string} suffix
 * @returns {EffectSection}
 */
function addPresetEffect(seq, file, opts = {}, point, token, suffix) {
  const tokenSize = numberOr(token.document?.width, 1);
  const sizeValue = numberOr(opts.size, 1);
  const size = opts.isRadius ? sizeValue * 2 : tokenSize * 1.5 * sizeValue;
  const elevation = numberOr(opts.elevation, 1000);

  const effect = seq.effect()
    .file(file)
    .atLocation({ x: point.x, y: point.y })
    .size(size, { gridUnits: true })
    .opacity(numberOr(opts.opacity, 1))
    .fadeIn(numberOr(opts.fadeIn, 250))
    .fadeOut(numberOr(opts.fadeOut, 250))
    .delay(numberOr(opts.delay, 0))
    .playbackRate(numberOr(opts.playbackRate, 1))
    .name(`movement-fx-${token.id}-${suffix}`);

  if (elevation === 0) {
    effect.belowTokens(true);
  } else {
    effect.elevation(numberOr(point.elevation, 0), { absolute: true });
    effect.onLevels(point.level ?? canvas?.level);
  }

  if (opts.isMasked) effect.mask(token);
  return effect;
}

/**
 * Play the primary animation at the departure point and the target animation
 * at the arrival point, using Automated Animations' own option handling.
 * @param {Token} token
 * @param {object} flags
 * @param {{origin: object, destination: object}} endpoints
 * @param {object} options
 * @returns {Promise<boolean>}
 */
async function playTeleportAA(token, flags, endpoints, options) {
  const api = globalThis.AutomatedAnimations;
  if (!api?.playAnimation) return false;

  const originFlags = buildOriginFlags(flags);
  const destinationFlags = buildDestinationFlags(flags);
  if (!originFlags || !destinationFlags) return false;

  const targetOptions = flags.target?.video && sectionEnabled(flags.target)
    ? flags.target.options
    : flags.primary?.options;
  const fallbackDelay = options.defaultArrivalDelay ?? TELEPORT_ARRIVAL_DELAY;
  const arrivalDelay = Math.max(0, numberOr(targetOptions?.delay, fallbackDelay));
  // The wait below is the arrival delay; avoid applying it a second time in AA.
  destinationFlags.primary.options.delay = 0;

  const playbackId = foundry.utils.randomID(4);
  const originItem = buildSyntheticItem(originFlags, `origin-${playbackId}`);
  const destinationItem = buildSyntheticItem(destinationFlags, `destination-${playbackId}`);
  let originPlayed = false;
  let destinationPlayed = false;

  try {
    const originToken = buildOriginToken(token, endpoints.origin);
    const originHandler = await api.playAnimation(originToken, originItem, { targets: [] });
    originPlayed = !!originHandler;
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to play departure animation`, err);
  }

  await waitForMovement(options.movement, token);
  if (options.isCurrent && !options.isCurrent()) {
    // A newer movement superseded this one; do not start the arrival or fall back.
    return true;
  }

  if (arrivalDelay > 0) await wait(arrivalDelay);

  try {
    // Pass the token at the drop point as an actual AA target. The arrival
    // flags use Play On: Target, so AA places the effect on the destination
    // token (the mouse-drop point) instead of treating it as a source effect.
    const destinationHandler = await api.playAnimation(token, destinationItem, { targets: [token] });
    destinationPlayed = !!destinationHandler;
    // Reveal the token once Automated Animations has accepted the arrival
    // effect and started compiling/playing it.
    options.hide.release();
  } catch (err) {
    options.hide.release();
    console.error(`${MODULE_ID} | Failed to play arrival animation`, err);
  }

  // Teleport needs both halves; non-teleport actions are happy with either
  // half and let the caller use normal playback only if both failed.
  if (options.requireBoth === false) return originPlayed || destinationPlayed;
  return originPlayed && destinationPlayed;
}

/**
 * Build the flags used for the departure animation: the primary section,
 * played on the source, without extra sections.
 * @param {object} flags
 * @returns {object|null}
 */
function buildOriginFlags(flags) {
  if (!flags?.primary?.video) return null;

  const data = foundry.utils.deepClone(flags);
  data.menu = "ontoken";
  data.isCustomized = true;
  data.isEnabled = true;
  data.primary.video.dbSection ??= "static";
  data.primary.options ??= {};
  data.primary.options.playOn = "source";
  data.primary.options.persistent = false;
  data.primary.options.isMasked = false;
  data.primary.options.isWait = false;
  data.source = { enable: false };
  data.levels3d = { enable: false };
  data.macro = { enable: false };
  // Only the departure half is played here. Target/Secondary must be removed,
  // not merely disabled: the user may have deleted or disabled them in AA.
  data.target = false;
  data.secondary = false;
  return data;
}

/**
 * Build the flags used for the arrival animation. The AA "Target" section is
 * used when present; otherwise the primary animation is reused. The effect is
 * played with Play On: Target so the token at the mouse-drop point is passed
 * to AA as the actual target.
 * @param {object} flags
 * @returns {object|null}
 */
function buildDestinationFlags(flags) {
  const target = flags?.target;
  const source = target?.video && sectionEnabled(target) ? target : flags?.primary;
  if (!source?.video) return null;

  const data = foundry.utils.deepClone(flags);
  data.menu = "ontoken";
  data.isCustomized = true;
  data.isEnabled = true;
  data.primary = {
    video: {
      ...foundry.utils.deepClone(source.video),
      dbSection: source.video.dbSection ?? "static"
    },
    sound: foundry.utils.deepClone(source.sound ?? { enable: false }),
    options: {
      ...foundry.utils.deepClone(source.options ?? {}),
      playOn: "target",
      isWait: false
    }
  };
  data.source = { enable: false };
  data.levels3d = { enable: false };
  data.macro = { enable: false };
  // Only the arrival half is played. Target/Secondary are removed so a
  // disabled or deleted section in AA can never fire again.
  data.target = false;
  data.secondary = false;
  return data;
}

/**
 * Build a minimal Item-like object from Automated Animations flags so AA can
 * compile and play it without creating a real world Item.
 * @param {object} entry
 * @param {string} [suffix] Makes the synthetic uuid unique per endpoint.
 * @returns {object}
 */
export function buildSyntheticItem(entry, suffix = "") {
  const flags = foundry.utils.deepClone(entry);
  flags.isCustomized = true;
  flags.isEnabled = true;
  flags.killAnim = false;
  flags.menu ??= "ontoken";

  // Preserve the playback mode chosen by the caller (Source for departure,
  // Target for arrival). Only default to Source when the entry does not
  // specify one, such as a normal Global Menu animation.
  if (flags.primary) {
    flags.primary.options ??= {};
    flags.primary.options.playOn ??= "source";
  }

  let current = Number.NaN;
  try {
    current = Number(game.settings.get("autoanimations", "aaAutorec")?.version);
  } catch {
    // Automated Animations is not initialized yet.
  }
  flags.version = Number.isFinite(current)
    ? Math.max(current, 5)
    : Math.max(Number(flags.version) || 0, 5);

  const baseId = entry.id ?? foundry.utils.randomID();
  const id = suffix ? `${baseId}-${suffix}` : baseId;

  const item = {
    id,
    uuid: `MovementFX.${id}`,
    name: getEntryLabel(entry),
    type: "base",
    img: "icons/svg/aura.svg",
    system: {},
    radius: 0,
    flags: { autoanimations: flags },
    getMacro: () => ({ command: "" }),
    update: async updates => {
      for (const [key, value] of Object.entries(updates)) {
        if (key === "flags.-=autoanimations") delete item.flags.autoanimations;
        else if (key === "flags.autoanimations") item.flags.autoanimations = value;
        else foundry.utils.setProperty(item, key, value);
      }
      return item;
    }
  };
  return item;
}

/**
 * Build a token-like object positioned at the departure point. Automated
 * Animations and Sequencer only need a document, a center, and a few size
 * properties to compile and place the departure effect.
 * @param {Token} token
 * @param {{x: number, y: number, elevation: number, level: string}} point
 * @returns {object}
 */
function buildOriginToken(token, point) {
  const gridSize = canvas?.grid?.size ?? 100;
  const width = token.w ?? (token.document?.width ?? 1) * gridSize;
  const height = token.h ?? (token.document?.height ?? 1) * gridSize;

  const source = token.document.toObject();
  delete source.uuid;
  // Sequencer validates the fake token by reading its document identifier.
  // Without an id it falls back to the document name (e.g. "test man") and
  // fails with "could not find object with ID". Reuse the real token's id so
  // validation resolves to the actual token while the effect still anchors to
  // the fake token positioned at the departure point.
  source.id = source._id ?? token.document?.id;
  source.x = point.x - width / 2;
  source.y = point.y - height / 2;
  source.elevation = point.elevation ?? source.elevation ?? 0;
  source.level = point.level ?? source.level ?? canvas?.level;
  source.documentName = "Token";
  source.parent = canvas?.scene;
  source.width ??= token.document?.width ?? 1;
  source.height ??= token.document?.height ?? 1;
  source.texture ??= { scaleX: 1, scaleY: 1 };
  source.texture.scaleX ??= 1;
  source.texture.scaleY ??= 1;
  source.ring ??= { enabled: false, subject: { scale: 1 } };
  source.ring.subject ??= { scale: 1 };
  source.ring.subject.scale ??= 1;
  source.object = null;

  // Sequencer's effect manager only accepts Document/PlaceableObject/string
  // objects. Assign the own properties first, then set PlaceableObject's
  // prototype: this satisfies the instanceof check without invoking its
  // read-only id/center getters.
  const originToken = {};
  Object.assign(originToken, {
    id: `${token.id}-origin-${foundry.utils.randomID(4)}`,
    name: token.name,
    document: source,
    documentName: "Token",
    parent: canvas?.scene,
    center: { x: point.x, y: point.y },
    x: source.x,
    y: source.y,
    width: source.width,
    height: source.height,
    w: width,
    h: height,
    elevation: source.elevation,
    level: source.level,
    scene: canvas?.scene,
    actor: token.actor,
    getCenter: () => originToken.center,
    checkCollision: () => false
  });

  const PlaceableObject = foundry.canvas?.placeables?.PlaceableObject;
  if (PlaceableObject) Object.setPrototypeOf(originToken, PlaceableObject.prototype);

  source.object = originToken;
  return originToken;
}

/**
 * Build a Sequencer database key (or custom path) from AA video data.
 * @param {object} video
 * @returns {string|null}
 */
function buildAAFile(video) {
  if (!video) return null;
  if (video.enableCustom && video.customPath) return video.customPath;

  const section = video.dbSection ?? "static";
  const { menuType, animation, variant, color } = video;
  if (!menuType || !animation || !variant) return null;

  const base = `autoanimations.${section}.${menuType}.${animation}.${variant}`;
  return color && color !== "random" ? `${base}.${color}` : base;
}

