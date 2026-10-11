// Fluxer has no buttons or select menus yet, so a message's `components` are
// rendered as reactions plus a short legend in the message text:
//
//   - a button with a unicode emoji reacts with that emoji; otherwise the first
//     emoji in its label, otherwise the next free number emoji
//   - each option of a select menu is one reaction (ten at most)
//   - link buttons become plain markdown links, no reaction
//
// planComponents() is the pure half: it only describes what to render. The
// reaction half (reactionBridge.js) stores the actions and turns a reaction
// back into the interaction the registered handler expects.
const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const MAX_SELECT_OPTIONS = 10;
const LEADING_EMOJI = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*/u;
const ButtonStyleLink = 5;
const ComponentType = { ActionRow: 1, Button: 2, StringSelect: 3 };

const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);

/** The unicode emoji a component asks for, or null (no emoji, or a server emoji). */
function unicodeEmoji(emoji) {
  if (!emoji || emoji.id) return null;
  return emoji.name || null;
}

/** Split a leading emoji off a label: "✅ Verify" → { emoji: '✅', label: 'Verify' }. */
function splitLabel(label = '') {
  const m = LEADING_EMOJI.exec(label);
  return m ? { emoji: m[1], label: label.slice(m[0].length) } : { emoji: null, label };
}

function collect(components) {
  const items = [];
  const links = [];
  for (const row of (components ?? []).map(json)) {
    if (row?.type !== ComponentType.ActionRow) continue;
    for (const c of (row.components ?? []).map(json)) {
      if (c.disabled) continue;
      if (c.type === ComponentType.Button) {
        if (c.style === ButtonStyleLink) {
          if (c.url) links.push({ label: c.label ?? c.url, url: c.url });
          continue;
        }
        if (!c.custom_id) continue;
        const own = unicodeEmoji(c.emoji);
        const split = own ? { emoji: own, label: c.label ?? '' } : splitLabel(c.label);
        items.push({ kind: 'button', customId: c.custom_id, emoji: split.emoji, label: split.label });
      } else if (c.type === ComponentType.StringSelect) {
        for (const o of (c.options ?? []).slice(0, MAX_SELECT_OPTIONS)) {
          items.push({
            kind: 'select',
            customId: c.custom_id,
            value: o.value,
            emoji: unicodeEmoji(o.emoji),
            label: o.label,
          });
        }
      }
    }
  }
  return { items, links };
}

/**
 * @param {Array<object> | undefined} components  discord.js rows or API JSON
 * @returns {{ actions: Array<{ kind: 'button'|'select', customId: string, value?: string, emoji: string, label: string }>,
 *             links: Array<{ label: string, url: string }>, text: string }}
 */
export function planComponents(components) {
  const { items, links } = collect(components);

  // An explicit emoji is kept unless an earlier action already took it; every
  // other action gets the next number emoji nobody is using.
  const used = new Set();
  for (const item of items) {
    if (item.emoji && !used.has(item.emoji)) used.add(item.emoji);
    else item.emoji = null;
  }
  const free = NUMBERS.filter((n) => !used.has(n));
  const actions = [];
  for (const item of items) {
    const emoji = item.emoji ?? free.shift();
    if (emoji) actions.push({ ...item, emoji }); // out of emoji: the action cannot be reached, so it is dropped
  }

  const lines = [
    ...actions.map((a) => `${a.emoji} ${a.label}`),
    ...links.map((l) => `🔗 [${l.label}](${l.url})`),
  ];
  const header = actions.length ? 'React to choose:\n' : '';
  return { actions, links, text: lines.length ? header + lines.join('\n') : '' };
}

/** Add the plan's legend to a payload's content. */
export function withComponentText(payload, plan) {
  if (!plan.text) return payload;
  return { ...payload, content: payload.content ? `${payload.content}\n\n${plan.text}` : plan.text };
}
