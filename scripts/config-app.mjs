import { DEFAULT_ACTION, MODULE_ID } from "./constants.mjs";
import { playMovementFx } from "./fx.mjs";
import {
  getAAOptions,
  getActionConfig,
  getMappings,
  getTokenOverrides,
  isAAActive,
  isSequencerActive,
  isTokenEnabled,
  setTokenEnabled,
  setTokenOverrides
} from "./settings.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Movement actions that are meaningful in the settings table. Core registers
 * internal actions such as "displace" with canSelect: false; those never appear
 * in the Token HUD, so showing them here only creates confusion. When a token is
 * selected, use it to evaluate canSelect exactly like the HUD does.
 * @returns {[string, object][]}
 */
export function getConfigurableActions() {
  const token = canvas?.tokens?.controlled?.[0]?.document
    ?? canvas?.tokens?.placeables?.[0]?.document
    ?? {};

  return Object.entries(CONFIG.Token.movement.actions).filter(([, action]) => {
    if (typeof action.canSelect !== "function") return action.canSelect !== false;
    try {
      return !!action.canSelect(token);
    } catch {
      // System/module actions may require a real TokenDocument. Include them
      // rather than hiding an action because the probe was incomplete.
      return true;
    }
  });
}

/** Section a movement action belongs to, in display order. */
function actionSection(id) {
  return id === "blink" || id === "burrow" ? "presets" : "other";
}

/** Lowercase text without accents, so "escavar" also matches "Escavar". */
function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export class MovementFxConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    const token = options.token ?? null;
    // ApplicationV2 freezes `this.options`, so id/title must be passed to
    // super() rather than assigned afterwards.
    const opts = token
      ? {
          ...options,
          id: "token-movement-fx-config-token",
          window: { ...(options.window ?? {}), title: "TMFX.Settings.TokenTitle" }
        }
      : options;
    super(opts);
    this.token = token;
  }

  static DEFAULT_OPTIONS = {
    id: "token-movement-fx-config",
    classes: ["token-movement-fx"],
    tag: "form",
    window: {
      title: "TMFX.Settings.Title",
      icon: "fa-solid fa-person-from-portal",
      resizable: true
    },
    position: {
      width: 780,
      height: "auto"
    },
    actions: {
      test: MovementFxConfig.#onTest,
      openAA: MovementFxConfig.#onOpenAA,
      openSequencer: MovementFxConfig.#onOpenSequencer,
      refresh: MovementFxConfig.#onRefresh,
      reset: MovementFxConfig.#onReset
    },
    form: {
      handler: MovementFxConfig.#onSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: {
      template: "modules/token-movement-fx/templates/config.hbs"
    }
  };

  /** True while the form holds edits that were not saved yet. */
  #dirty = false;

  /**
   * Wire the search box above each animation select to filter its options as
   * the user types. The browser still renders the native dropdown, but only the
   * matching entries remain.
   * @override
   */
  _onRender(context, options) {
    super._onRender(context, options);
    // A render always mirrors the stored settings, so nothing is pending.
    this.#dirty = false;
    for (const input of this.element.querySelectorAll("input[type='search'][data-filter-for]")) {
      input.addEventListener("input", () => this.#applyFilter(input));
    }
    for (const toggle of this.element.querySelectorAll("input[data-dedicated-toggle]")) {
      toggle.addEventListener("change", () => this.#toggleDedicated(toggle));
      this.#toggleDedicated(toggle);
    }
    for (const select of this.element.querySelectorAll("select[name$='.animationId']")) {
      select.addEventListener("change", () => this.#onAnimationChange(select));
    }
  }

  /**
   * Remember that the form has pending edits so closing can warn the user.
   * @override
   */
  _onChangeForm(formConfig, event) {
    super._onChangeForm(formConfig, event);
    // Typing in a search box only filters the dropdown; it is not an edit.
    if (event.target?.matches?.("input[type='search'][data-filter-for]")) return;
    this.#dirty = true;
  }

  /**
   * Ask before discarding unsaved edits. A programmatic submit (Save button)
   * or a forced close skips the prompt.
   * @override
   */
  async close(options = {}) {
    if (this.#dirty && !options?.submitted && !options?.force) {
      const choice = await this.#confirmClose();
      if (choice === "save") {
        try {
          await this.submit();
        } catch (err) {
          console.error(`${MODULE_ID} | Could not save before closing`, err);
          return this;
        }
        this.#dirty = false;
      } else if (choice === "discard") {
        this.#dirty = false;
      } else {
        // "cancel", or dismissed with Escape: keep the window open.
        return this;
      }
    }
    return super.close(options);
  }

  /** Prompt to save or discard pending edits before closing. */
  async #confirmClose() {
    const { DialogV2 } = foundry.applications.api;
    return DialogV2.wait({
      window: { title: game.i18n.localize("TMFX.Settings.UnsavedTitle") },
      content: `<p>${game.i18n.localize("TMFX.Settings.UnsavedMessage")}</p>`,
      modal: true,
      buttons: [
        {
          action: "save",
          label: game.i18n.localize("TMFX.Settings.Save"),
          icon: "fa-solid fa-floppy-disk",
          default: true
        },
        {
          action: "discard",
          label: game.i18n.localize("TMFX.Settings.Discard"),
          icon: "fa-solid fa-trash"
        },
        {
          action: "cancel",
          label: game.i18n.localize("TMFX.Settings.Cancel"),
          icon: "fa-solid fa-xmark"
        }
      ]
    });
  }

  /**
   * Picking an animation activates it: "Ativo" in the global window, or
   * "Animação dedicada" in the per-token window.
   */
  #onAnimationChange(select) {
    const row = select.closest("tr[data-action-id]");
    if (!row) return;
    if (this.token) {
      // On a token, even "None" is a deliberate choice and must be stored as
      // an override, otherwise the token would keep following the global one.
      const dedicated = row.querySelector("input[name$='.dedicated']");
      if (dedicated && !dedicated.checked) {
        dedicated.checked = true;
        this.#toggleDedicated(dedicated);
      }
    } else if (select.value) {
      // Globally, only a real animation turns the row on.
      const enabled = row.querySelector("input[name$='.enabled']");
      if (enabled && !enabled.checked) enabled.checked = true;
    }
    this.#dirty = true;
  }

  /** Enable/disable a token row's extra fields based on its checkbox. */
  #toggleDedicated(toggle) {
    const row = toggle.closest("tr[data-action-id]");
    if (!row) return;
    const active = toggle.checked;
    for (const field of row.querySelectorAll("[data-dedicated-field]")) {
      field.disabled = !active;
    }
  }

  /** Filter one animation dropdown using its search field. */
  #applyFilter(input) {
    const row = input.closest("tr[data-action-id]");
    const select = row?.querySelector("select[name$='.animationId']");
    if (!select) return;

    const term = normalize(input.value);
    for (const option of select.options) {
      if (!option.value) {
        // "None" always stays so the field can be cleared.
        option.hidden = false;
        continue;
      }
      if (option.selected) {
        // Never hide the current choice: Save must not silently switch it.
        option.hidden = false;
        continue;
      }
      const search = normalize(option.dataset.search ?? option.textContent);
      option.hidden = !!term && !search.includes(term);
    }
  }

  /**
   * Build the settings table. Every animation source is selectable: presets,
   * On Token and AEFX entries (Items are excluded because they are already
   * represented by the A-A button and are harder to keep in sync).
   * @override
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const aaOptions = getAAOptions();
    const tokenDoc = this.token;

    const sectionOrder = { presets: 0, other: 1 };
    const rows = getConfigurableActions()
      .sort(([idA, a], [idB, b]) => {
        const bySection = (sectionOrder[actionSection(idA)] ?? 9) - (sectionOrder[actionSection(idB)] ?? 9);
        return bySection || (a.order ?? 0) - (b.order ?? 0);
      });

    const selectable = aaOptions.filter(option => option.kind !== "item");
    const tokenOverrides = tokenDoc ? getTokenOverrides(tokenDoc) : null;

    const actions = rows.map(([id, action], index) => {
      const firstOfSection = index === 0
        || actionSection(id) !== actionSection(rows[index - 1][0]);
      const config = getActionConfig(id, tokenDoc);
      const animationId = config.animationId;
      const dedicated = !!tokenOverrides?.[id]?.dedicated;
      return {
        id,
        label: action.label ? game.i18n.localize(action.label) : id,
        img: action.img,
        icon: action.icon,
        teleport: !!action.teleport,
        enabled: config.enabled,
        animationId,
        hide: config.hide,
        removePersistent: config.removePersistent,
        dedicated,
        tokenMode: !!tokenDoc,
        options: [
          {
            value: "",
            label: game.i18n.localize("TMFX.Settings.None"),
            selected: !animationId,
            search: "none nenhuma"
          },
          ...selectable.map(option => ({
            ...option,
            selected: option.value === animationId
          }))
        ],
        showSection: firstOfSection,
        sectionLabel: game.i18n.localize(`TMFX.Settings.Section.${actionSection(id)}`)
      };
    });

    return Object.assign(context, {
      actions,
      aaActive: isAAActive(),
      sequencerActive: isSequencerActive(),
      hasAAOptions: selectable.length > 0,
      tokenMode: !!tokenDoc,
      tokenName: tokenDoc?.name ?? "",
      tokenEnabled: isTokenEnabled(tokenDoc)
    });
  }

  static async #onSubmit(event, form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    const submitted = data.actions ?? {};

    // Per-token mode: write the overrides to the token's flags, only for the
    // actions the user explicitly dedicated to this token.
    if (this.token) {
      const overrides = {};
      for (const [id, raw] of Object.entries(submitted)) {
        if (!CONFIG.Token.movement.actions[id]) continue;
        if (!raw.dedicated) continue;
        overrides[id] = {
          dedicated: true,
          animationId: typeof raw.animationId === "string" ? raw.animationId : "",
          hide: !!raw.hide,
          removePersistent: !!raw.removePersistent
        };
      }
      await setTokenOverrides(this.token, overrides);
      await setTokenEnabled(this.token, !!data.tokenEnabled);
      ui.notifications.info(game.i18n.localize("TMFX.Notifications.Saved"));
      return;
    }

    const mappings = { ...getMappings() };
    for (const [id, raw] of Object.entries(submitted)) {
      if (!CONFIG.Token.movement.actions[id]) continue;
      mappings[id] = {
        enabled: !!raw.enabled,
        animationId: typeof raw.animationId === "string" ? raw.animationId : "",
        hide: !!raw.hide,
        removePersistent: !!raw.removePersistent
      };
    }

    await game.settings.set(MODULE_ID, "mappings", mappings);
    ui.notifications.info(game.i18n.localize("TMFX.Notifications.Saved"));
  }

  /** Clear this token's overrides so it follows the global settings again. */
  static async #onReset() {
    if (!this.token) return;
    await setTokenOverrides(this.token, {});
    await setTokenEnabled(this.token, true);
    ui.notifications.info(game.i18n.localize("TMFX.Notifications.Reset"));
    this.render({ force: true });
  }

  static async #onTest(event, target) {
    const row = target.closest("tr[data-action-id]");
    if (!row) return;

    const actionId = row.dataset.actionId;
    const animationId = row.querySelector("select[name$='.animationId']")?.value ?? "";
    const hide = !!row.querySelector("input[type='checkbox'][name$='.hide']")?.checked;
    const removePersistent = !!row.querySelector("input[type='checkbox'][name$='.removePersistent']")?.checked;

    if (!animationId) {
      ui.notifications.warn(game.i18n.localize("TMFX.Notifications.NothingToPlay"));
      return;
    }

    const token = this.token?.object
      ?? canvas.tokens?.controlled?.[0]
      ?? canvas.tokens?.placeables?.find(candidate => candidate.document.isOwner)
      ?? canvas.tokens?.placeables?.[0];

    if (!token) {
      ui.notifications.warn(game.i18n.localize("TMFX.Notifications.NoToken"));
      return;
    }

    const played = await playMovementFx(token, actionId, {
      enabled: true,
      animationId,
      hide,
      removePersistent
    }, { test: true });
    if (played) return;

    // The stored reference may point to an entry that was renamed or deleted.
    const known = getAAOptions().some(option => option.value === animationId);
    ui.notifications.warn(game.i18n.localize(
      known ? "TMFX.Notifications.TestFailed" : "TMFX.Notifications.NoAnimationsFound"
    ));
  }

  static async #onRefresh() {
    this.render({ force: true });
  }

  static async #onOpenAA() {
    if (!isAAActive()) {
      ui.notifications.warn(game.i18n.localize("TMFX.Notifications.NoAA"));
      return;
    }

    const menu = game.settings.menus.get("autoanimations.custom-autorec");
    if (!menu) {
      ui.notifications.warn(game.i18n.localize("TMFX.Notifications.NoAAMenu"));
      return;
    }

    try {
      new menu.type();
    } catch (err) {
      console.error(`${MODULE_ID} | Could not open the Automated Animations menu`, err);
      ui.notifications.error(game.i18n.localize("TMFX.Notifications.NoAAMenu"));
    }
  }

  static async #onOpenSequencer() {
    if (!isSequencerActive()) {
      ui.notifications.warn(game.i18n.localize("TMFX.Notifications.NoSequencer"));
      return;
    }

    try {
      const app = new globalThis.Sequencer.DatabaseViewer();
      app.render({ force: true });
    } catch (err) {
      console.error(`${MODULE_ID} | Could not open the Sequencer database viewer`, err);
      ui.notifications.error(game.i18n.localize("TMFX.Notifications.NoSequencer"));
    }
  }
}
