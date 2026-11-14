// Raw JSON of a message, in the shape Discord (and tools such as Discohook) use for a message: content,
// embeds and, for link buttons, components. Used by the message builder and the Welcome channel to export
// what is on the page and to import JSON pasted or loaded from a file.
//
// The page's own shape is the saved spec: { content, embeds: [{ kind, color, title, description, authorName,
// authorIcon, image, thumbnail, footerText, footerIcon, fields }], rows: [{ type: 'buttons', buttons }] }.
//
// Import never trusts the JSON: it is checked against the limits of one message (the server's own for an
// embed, and Discord's for the rest), and anything it cannot carry over is named in `warnings`, not dropped
// silently. Nothing here touches the server; the result fills the form, which is saved the usual way.

/** What Discord itself allows in one message, for what the server's embed limits do not list. */
export const DISCORD = Object.freeze({
  content: 2000,
  embeds: 10,
  totalChars: 6000,
  title: 256,
  description: 4096,
  authorName: 256,
  footerText: 2048,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  rows: 5,
  buttonsPerRow: 5,
  buttonLabel: 80,
});

const HEX = /^#[0-9a-f]{6}$/i;
const URL_RE = /^https?:\/\/\S+$/i;
const DEFAULT_COLOR = '#5865f2';
const MAX_ERRORS = 8;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * The limits to check an import against: the server's embed limits (`embed`, from `useModuleLimits('_embed')`)
 * and a message's own (`message`, from `useModuleLimits('welcome-channel')`: 'spec.content', 'spec.embeds'),
 * each falling back to Discord's number while they have not loaded.
 */
export function messageLimits(embed = {}, message = {}) {
  const len = (limits, key, fallback) => limits?.[key]?.maxLength ?? fallback;
  return {
    content: len(message, 'spec.content', DISCORD.content),
    embeds: message?.['spec.embeds']?.maxItems ?? DISCORD.embeds,
    title: len(embed, 'title', DISCORD.title),
    description: len(embed, 'description', DISCORD.description),
    authorName: len(embed, 'authorName', DISCORD.authorName),
    footerText: len(embed, 'footerText', DISCORD.footerText),
    fields: embed?.fields?.maxItems ?? DISCORD.fields,
    fieldName: len(embed, 'fields[].name', DISCORD.fieldName),
    fieldValue: len(embed, 'fields[].value', DISCORD.fieldValue),
  };
}

// --- Export -------------------------------------------------------------------------------------------------

const colorToInt = (hex) =>
  HEX.test(hex ?? '') ? parseInt(hex.slice(1), 16) : parseInt(DEFAULT_COLOR.slice(1), 16);

function emojiToJson(emoji) {
  const s = str(emoji).trim();
  if (!s) return undefined;
  const custom = /^<(a?):([A-Za-z0-9_]+):(\d+)>$/.exec(s);
  return custom ? { name: custom[2], id: custom[3], animated: custom[1] === 'a' } : { name: s };
}

/**
 * The saved spec of a message as Discord message JSON. Role buttons and menus are left out (they only work
 * through Sylo); a "banner" element becomes an embed with just an image and a caption.
 * @param {{ content?: string, embeds?: object[], rows?: object[] }} spec
 */
export function specToDiscordJson(spec) {
  const out = {};
  if (spec?.content) out.content = spec.content;
  const embeds = (Array.isArray(spec?.embeds) ? spec.embeds : []).map((e) => {
    const j = {};
    if (e.title) j.title = e.title;
    if (e.description) j.description = e.description;
    j.color = colorToInt(e.color);
    if (e.authorName) j.author = { name: e.authorName, ...(e.authorIcon ? { icon_url: e.authorIcon } : {}) };
    if (e.thumbnail) j.thumbnail = { url: e.thumbnail };
    if (e.image) j.image = { url: e.image };
    if (e.footerText) j.footer = { text: e.footerText, ...(e.footerIcon ? { icon_url: e.footerIcon } : {}) };
    const fields = (Array.isArray(e.fields) ? e.fields : []).filter((f) => f.name && f.value);
    if (fields.length)
      j.fields = fields.map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) }));
    return j;
  });
  if (embeds.length) out.embeds = embeds;
  const rows = [];
  for (const row of Array.isArray(spec?.rows) ? spec.rows : []) {
    const buttons = (row?.type === 'buttons' ? (row.buttons ?? []) : []).filter(
      (b) => b.style === 'link' && b.url
    );
    if (!buttons.length) continue;
    rows.push({
      type: 1,
      components: buttons.map((b) => ({
        type: 2,
        style: 5,
        ...(b.label ? { label: b.label } : {}),
        url: b.url,
        ...(emojiToJson(b.emoji) ? { emoji: emojiToJson(b.emoji) } : {}),
      })),
    });
  }
  if (rows.length) out.components = rows;
  return out;
}

// --- Import -------------------------------------------------------------------------------------------------

/** The message part of whatever was pasted: a message, a Discohook backup or export, a list of embeds or one embed. */
function messageOf(json, warnings) {
  if (Array.isArray(json)) return { embeds: json };
  if (!isObj(json)) return null;
  // Discohook backup: { backups: [{ messages: [{ data }] }] } and its share/export form { messages: [{ data }] }.
  const wrapped = Array.isArray(json.backups) ? json.backups[0]?.messages : json.messages;
  if (Array.isArray(wrapped) && wrapped.length) {
    if (wrapped.length > 1) {
      warnings.push(`The file holds ${wrapped.length} messages; only the first was imported.`);
    }
    return isObj(wrapped[0]?.data) ? wrapped[0].data : isObj(wrapped[0]) ? wrapped[0] : null;
  }
  if (isObj(json.data) && ('content' in json.data || 'embeds' in json.data)) return json.data;
  if (!('content' in json) && !('embeds' in json) && !('components' in json)) {
    // A single embed pasted on its own.
    if (['title', 'description', 'fields', 'author', 'footer', 'image'].some((k) => k in json)) {
      return { embeds: [json] };
    }
  }
  return json;
}

function colorOf(c) {
  if (typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 0xffffff) {
    return `#${c.toString(16).padStart(6, '0')}`;
  }
  if (typeof c === 'string' && HEX.test(c)) return c.toLowerCase();
  return DEFAULT_COLOR;
}

function emojiFromJson(e) {
  if (typeof e === 'string') return e;
  if (!isObj(e)) return '';
  if (e.id) return `<${e.animated ? 'a' : ''}:${e.name || 'emoji'}:${e.id}>`;
  return str(e.name);
}

/**
 * Message JSON as a spec for the form, checked against `limits` (see messageLimits).
 * @param {unknown} json  the parsed JSON
 * @param {ReturnType<typeof messageLimits>} [limits]
 * @param {{ links?: boolean }} [opts]  `links: false` for a page that has no buttons (the Welcome channel): the
 *   link buttons in the JSON are then listed as not carried over, not imported.
 * @returns {{ ok: true, spec: object, warnings: string[] } | { ok: false, errors: string[] }}
 */
export function discordJsonToSpec(json, limits = messageLimits(), { links = true } = {}) {
  const warnings = [];
  const errors = [];
  const err = (m) => {
    if (errors.length < MAX_ERRORS) errors.push(m);
  };
  const msg = messageOf(json, warnings);
  if (!isObj(msg))
    return {
      ok: false,
      errors: ['This is not a message. Expected an object with "content" and/or "embeds".'],
    };

  const content = msg.content === undefined || msg.content === null ? '' : msg.content;
  if (typeof content !== 'string') err('"content" must be text.');
  else if (content.length > limits.content)
    err(`The message text is ${content.length} characters; the limit is ${limits.content}.`);

  const rawEmbeds = msg.embeds === undefined || msg.embeds === null ? [] : msg.embeds;
  if (!Array.isArray(rawEmbeds)) err('"embeds" must be a list.');
  else if (rawEmbeds.length > limits.embeds)
    err(`The message has ${rawEmbeds.length} embeds; the limit is ${limits.embeds}.`);

  const embeds = [];
  let total = 0;
  let sawTimestamp = false;
  let sawTitleUrl = false;
  const url = (value, where) => {
    const v = str(value).trim();
    if (!v) return '';
    if (URL_RE.test(v)) return v;
    warnings.push(`${where}: "${v.slice(0, 40)}" is not a web address (https://…) and was left out.`);
    return '';
  };
  (Array.isArray(rawEmbeds) ? rawEmbeds.slice(0, limits.embeds) : []).forEach((raw, i) => {
    const at = `Embed ${i + 1}`;
    if (!isObj(raw)) return err(`${at} must be an object.`);
    const title = str(raw.title);
    const description = str(raw.description);
    const authorName = str(raw.author?.name);
    const footerText = str(raw.footer?.text);
    if (title.length > limits.title)
      err(`${at}: the title is ${title.length} characters; the limit is ${limits.title}.`);
    if (description.length > limits.description) {
      err(`${at}: the description is ${description.length} characters; the limit is ${limits.description}.`);
    }
    if (authorName.length > limits.authorName) {
      err(`${at}: the author name is ${authorName.length} characters; the limit is ${limits.authorName}.`);
    }
    if (footerText.length > limits.footerText) {
      err(`${at}: the footer is ${footerText.length} characters; the limit is ${limits.footerText}.`);
    }
    const rawFields = raw.fields === undefined || raw.fields === null ? [] : raw.fields;
    if (!Array.isArray(rawFields)) return err(`${at}: "fields" must be a list.`);
    if (rawFields.length > limits.fields)
      err(`${at} has ${rawFields.length} fields; the limit is ${limits.fields}.`);
    const fields = [];
    rawFields.slice(0, limits.fields).forEach((f, j) => {
      const fat = `${at}, field ${j + 1}`;
      if (!isObj(f)) return err(`${fat} must be an object.`);
      const name = str(f.name);
      const value = str(f.value);
      if (!name.trim() || !value.trim()) return err(`${fat} needs both a name and a value.`);
      if (name.length > limits.fieldName)
        err(`${fat}: the name is ${name.length} characters; the limit is ${limits.fieldName}.`);
      if (value.length > limits.fieldValue) {
        err(`${fat}: the value is ${value.length} characters; the limit is ${limits.fieldValue}.`);
      }
      total += name.length + value.length;
      fields.push({ name, value, inline: f.inline === true });
    });
    total += title.length + description.length + authorName.length + footerText.length;
    if (raw.timestamp) sawTimestamp = true;
    if (raw.url) sawTitleUrl = true;
    embeds.push({
      kind: 'embed',
      color: colorOf(raw.color),
      authorName,
      authorIcon: url(raw.author?.icon_url, `${at}, author icon`),
      title,
      description,
      image: url(raw.image?.url, `${at}, image`),
      thumbnail: url(raw.thumbnail?.url, `${at}, thumbnail`),
      footerText,
      footerIcon: url(raw.footer?.icon_url, `${at}, footer icon`),
      fields,
    });
  });
  if (total > DISCORD.totalChars) {
    err(`The embeds hold ${total} characters in all; Discord allows ${DISCORD.totalChars} in one message.`);
  }
  if (sawTimestamp) warnings.push('Timestamps are not imported.');
  // What a Discohook file adds to a message and a posted message of Sylo cannot use.
  if (msg.username || msg.avatar_url)
    warnings.push('The custom name and avatar (a webhook feature) are not imported.');
  if (
    (Array.isArray(msg.attachments) && msg.attachments.length) ||
    (Array.isArray(msg.files) && msg.files.length)
  ) {
    warnings.push('Attached files are not imported.');
  }
  if (msg.thread_name) warnings.push('The thread name (a forum post feature) is not imported.');
  if (msg.flags) warnings.push('The message flags are not imported.');
  if (sawTitleUrl) warnings.push('Links on embed titles are not imported.');

  // Link buttons only: the rest need Sylo to answer them.
  const rows = [];
  let skipped = 0;
  let linkSkipped = 0;
  const rawRows = msg.components === undefined || msg.components === null ? [] : msg.components;
  if (!Array.isArray(rawRows)) err('"components" must be a list.');
  else {
    for (const row of rawRows) {
      const buttons = [];
      for (const c of Array.isArray(row?.components) ? row.components : []) {
        if (c?.type === 2 && c.style === 5 && URL_RE.test(str(c.url))) {
          const label = str(c.label);
          if (label.length > DISCORD.buttonLabel)
            err(`A button label is ${label.length} characters; the limit is ${DISCORD.buttonLabel}.`);
          if (buttons.length < DISCORD.buttonsPerRow) {
            buttons.push({ style: 'link', label, emoji: emojiFromJson(c.emoji), url: str(c.url) });
          }
        } else {
          skipped += 1;
        }
      }
      if (!links) linkSkipped += buttons.length;
      else if (buttons.length && rows.length < DISCORD.rows) rows.push({ type: 'buttons', buttons });
    }
  }
  if (linkSkipped) {
    warnings.push(
      `${linkSkipped} link ${linkSkipped === 1 ? 'button was' : 'buttons were'} not imported: this page has no buttons.`
    );
  }
  if (skipped) {
    warnings.push(
      `${skipped} ${skipped === 1 ? 'button or menu' : 'buttons and menus'} that need a bot to answer ${skipped === 1 ? 'was' : 'were'} skipped. Only link buttons are imported.`
    );
  }

  if (!errors.length && !content.trim() && !embeds.length && !rows.length) {
    err('This JSON has no message text, embeds or link buttons.');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, spec: { content, embeds, rows }, warnings };
}

/**
 * Parse pasted or uploaded text as message JSON. Returns the same result as discordJsonToSpec, with a plain
 * error for text that is not JSON at all.
 */
export function parseMessageJson(text, limits, opts) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`This is not valid JSON (${String(e.message).slice(0, 80)}).`] };
  }
  return discordJsonToSpec(json, limits, opts);
}
