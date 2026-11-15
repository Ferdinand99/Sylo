/** Add `emoji` after the emojis already in a space-separated field, with one space between them. */
export function appendEmoji(text, emoji) {
  const current = String(text ?? '').trimEnd();
  return current ? `${current} ${emoji}` : emoji;
}
