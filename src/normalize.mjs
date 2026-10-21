/**
 * Deterministic text normalisation used to match names, roles, items and units
 * across documents written in English, German, Polish or Ukrainian.
 */

const SPECIAL_LETTERS = {
  'ł': 'l', 'Ł': 'l', 'ß': 'ss', 'ø': 'o', 'Ø': 'o', 'æ': 'ae', 'Æ': 'ae', 'đ': 'd', 'Đ': 'd', 'œ': 'oe', 'Œ': 'oe',
};

/**
 * Lower-case, strip diacritics and compatibility forms ("m³" -> "m3", "Ł" -> "l").
 * @param {unknown} text
 * @returns {string}
 */
export function foldText(text) {
  return String(text ?? '')
    .replace(/[łŁßøØæÆđĐœŒ]/g, (ch) => SPECIAL_LETTERS[ch])
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/**
 * Order-independent matching key: "Kordecki, Adam" and "Adam Kordecki" both
 * become "adam kordecki".
 * @param {unknown} text
 * @returns {string}
 */
export function matchKey(text) {
  return foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Article-code key: "rmc-c30" and "RMC C30" both become "RMCC30".
 * @param {unknown} text
 * @returns {string|null}
 */
export function codeKey(text) {
  if (text === null || text === undefined) return null;
  const key = foldText(text).replace(/[^\p{L}\p{N}]+/gu, '').toUpperCase();
  return key || null;
}

const UNIT_SYNONYMS = {
  h: ['h', 'hr', 'hrs', 'hour', 'hours', 'std', 'stunde', 'stunden', 'godz', 'godzina', 'godziny', 'godzin', 'год', 'година', 'години', 'годин'],
  m3: ['m3', 'm³', 'cbm', 'qbm', 'm^3', 'м3', 'м³'],
  m2: ['m2', 'm²', 'qm', 'sqm', 'м2', 'м²'],
  m: ['m', 'lfm', 'mb', 'м'],
  t: ['t', 'to', 'tonne', 'tonnes', 'ton', 'tons', 'т'],
  kg: ['kg', 'кг'],
  pcs: ['pcs', 'pc', 'piece', 'pieces', 'stk', 'stück', 'stueck', 'szt', 'sztuk', 'sztuki', 'шт'],
  roll: ['roll', 'rolls', 'rolle', 'rollen', 'rol', 'rolka', 'rolki', 'rolek', 'рулон', 'рулони', 'рулонів'],
  day: ['day', 'days', 'tag', 'tage', 'dzien', 'dzień', 'dni', 'день', 'дні', 'днів'],
  l: ['l', 'litre', 'liter', 'litr', 'л'],
};

const UNIT_LOOKUP = new Map();
for (const [canonical, words] of Object.entries(UNIT_SYNONYMS)) {
  for (const word of words) UNIT_LOOKUP.set(foldText(word), canonical);
}

/**
 * Canonical unit: "Std." -> "h", "godz." -> "h", "m³" -> "m3", "Rollen" -> "roll".
 * Unknown units are returned folded so that they still compare equal to themselves.
 * @param {unknown} unit
 * @returns {string}
 */
export function normalizeUnit(unit) {
  const folded = foldText(unit).replace(/\s+/g, '').replace(/\.+$/, '');
  return UNIT_LOOKUP.get(folded) ?? folded;
}
