Here is the English translation of the README, maintaining the original formatting and technical clarity:

***

# Token Movement FX

Links each token **movement action** (Teleport, Burrow, Walk, Fly…) to a **Sequencer** animation created in **Automated Animations**. For Teleport/Burrow with a **preset**, Automated Animations itself handles the sound, animation, disappearing, and displacement.

## Prerequisites

- **Foundry VTT v14** (minimum and verified).
- **Sequencer** — required.
- **Automated Animations (AA)** — required to select animations.
- **JB2A Patreon** (or another Sequencer pack) — recommended; provides the videos used by AA.
- **GM** permissions to configure.

The module **does not create or edit** animations: it only decides which existing animation plays for each movement.

## Activation

1. Enable **Sequencer**, **Automated Animations**, and **Token Movement FX**.
2. In **Settings → Token Movement FX**, keep **Enable Token Movement FX** checked (global world toggle).

## Quick Start

1. Select a token and open the **HUD**.
2. Open the **movement actions** selector and click on **Universal Animation**.
3. On the movement row, choose the animation. **Active** turns on automatically.
4. Click **Test** to check it on the selected token.
5. Move the token using that action.

## Where to Configure

| Where | Scope |
| --- | --- |
| **Settings → Token Movement FX → Configure animations** | All tokens |
| **HUD → Universal Animation** | All tokens |
| **HUD → Token Animation** | Only the selected token |

HUD entries only appear for the GM.

## The Configuration Table

Each row is a movement type.

| Column | Function |
| --- | --- |
| **Active** | Turns that movement on/off for all tokens. |
| **Dedicated animation** | (Token only) uses that token's own configuration for that movement; if unchecked, it follows the universal one. Turns on automatically when an animation is selected. |
| **Animation** | Which animation plays. The search above the list ignores accents and case. |
| **Hide during movement** | Hides the token between departure and arrival. Checked by default for Teleport. |
| **Remove persistent animations** | Removes, at the end of the movement, only the persistent effects it created on that token. |
| **Test** | Plays on the selected token using the current screen values (no need to save). |

- When closing with pending changes, the module asks to **Save**, **Discard**, or **Cancel**.
- **Restore default** (token window) clears dedications and goes back to following the universal configuration.
- **Enable animations on this token** turns off all animations for that token only.

## Animations Available in the List

- **On Token — …**: entry from the Automated Animations *On Token* menu.
- **AEFX — …**: entry from the AA *Active Effect* menu.
- **Preset — …**: AA **teleport** preset (e.g., **Misty Step**).

World items configured via the **A-A** button do not appear in this list.

## Behavior by Case

### Teleport Preset (Any Action)

Choosing a **Preset — …** makes the module cancel Foundry's normal movement and hand the token over to AA:

- the point where you **released the mouse** becomes the destination; the AA range circle is ignored and removed;
- AA plays **sound**, **departure**, **Between** (if enabled), and **arrival**, and makes the token **disappear, move, and reappear**;
- **Alpha**, **Delay Fade**, **Delay Return**, and **Delay Move** from the preset control the fade and timing. The module's **Hide** checkbox is not used here.

### Multi-Point Path (Ctrl + Click)

1. Choose **Teleport** (or **Burrow**) in the HUD.
2. Drag the token and, holding **Ctrl/Cmd**, click the intermediate points.
3. Release: the module plays **a sequence** — departure at the first point, **Between** for each segment (A→B, B→C, C→D), and arrival at the last one. The token remains invisible from start to finish.
4. Without **Between** enabled in the preset, there is only a departure at A and an arrival at D.

### On Token/AEFX with Departure and Arrival

1. Departure plays at the origin as soon as the movement starts.
2. With **Hide** checked, the token is invisible during displacement.
3. Arrival plays at the destination, and the token reappears.

### On Token/AEFX without Arrival (Non-Teleport Actions)

The animation plays once, at the origin, when the movement starts. This is the typical case for **persistent** effects.

## Persistent Animations

1. In AA, create an **On Token** animation and check **Persistent**.
2. Select it on the movement row and check **Remove persistent animations**.
3. The effect follows the token; when the movement ends, the module removes **only** the persistent effects it created on that token. Other persistent auras remain.

> Removal applies to animations **without arrival** (single departure) in non-Teleport actions — for example, **Burrow**, **Walk**, and **Fly**. In presets and **Teleport**, AA controls the effect, and the checkbox does not apply.

## Per-Token Configuration

In **HUD → Token Animation**:

- **Enable animations on this token** — turns everything off for it only.
- **Dedicated animation** per movement — the token stops following the universal one for that movement.
- **Restore default** — clears dedications.

Choices are saved on the **scene token**, not the actor.

## Limitations

- The trigger is the **token movement action** (drag, HUD, or keyboard). Movements via macro/API are not detected.
- Regular users do not see the effect if the token is hidden.
- Only **one** client moves the document (Active GM on the scene → token owner → whoever initiated), to prevent duplicate movements. The animation plays on all clients that see the scene.
- Foundry internal actions, such as **Displace**, do not appear in the table or the HUD.
- Size, color, sound, and other animation settings remain in Automated Animations.

## Troubleshooting

- Confirm that **Sequencer** and **JB2A** are active and that **Enable Token Movement FX** is checked.
- Confirm that the token was moved with the **correct action** (e.g., Teleport, not Walk).
- If the animation does not appear in the list, save the entry in AA and click **Refresh list**.
- In delegated presets, confirm that **Start** and/or **End** are enabled in the AA preset.
- Open the console (**F12**) and look for `Automated Animations did not open its teleport target listener` or red errors.

## API (Macros)

```js
const fx = game.modules.get("token-movement-fx").api;

// token = placeable (canvas.tokens.controlled[0], token.object, ...)
await fx.play(canvas.tokens.controlled[0], "blink", {
  enabled: true,
  animationId: "preset:default:mistystep",
  hide: true,
  removePersistent: false
});

fx.getMappings();                      // global configuration
fx.getActionConfig("blink", tokenDoc); // effective configuration (with token override)
```