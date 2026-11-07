// How the game API names a console or PC platform, as people write it.
const PLATFORM_LABELS = {
  pc: 'PC',
  ps3: 'PlayStation 3',
  ps4: 'PlayStation 4',
  ps5: 'PlayStation 5',
  xbox360: 'Xbox 360',
  xboxone: 'Xbox One',
  xbsx: 'Xbox Series X|S',
};

/** "pc" -> "PC", "xboxone" -> "Xbox One"; an unknown id just gets a capital letter. */
export function platformLabel(id) {
  const s = String(id ?? '').trim();
  return PLATFORM_LABELS[s.toLowerCase()] ?? (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
}
