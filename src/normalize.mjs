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

/** Name parts, folded to letters only: "K. Vogelsang" -> ["k", "vogelsang"]. */
function nameTokens(text) {
  return String(text ?? '')
    .split(/[\s.,]+/)
    .map((part) => foldText(part).replace(/[^\p{L}]+/gu, ''))
    .filter(Boolean);
}

// Words that introduce a sign-off instead of naming the signer, folded, longest first.
const SIGN_OFF_WORDS = [
  'signed off by', 'signed by', 'signed', 'sign-off',
  'unterschrieben von', 'unterschrieben', 'abgezeichnet', 'gezeichnet', 'gez.',
  'podpisano przez', 'podpisano', 'podpisala', 'podpisal', 'podpis',
  'підписано', 'підписала', 'підписав', 'підпис',
];

/**
 * The signer's name without the sign-off word in front of it: "unterschrieben K. Vogelsang" ->
 * "K. Vogelsang", "signed by J. Smith" -> "J. Smith". Text without such a word is returned trimmed.
 * @param {unknown} text
 * @returns {string}
 */
export function stripSignOffWords(text) {
  const raw = String(text ?? '').trim();
  const folded = foldText(raw);
  for (const word of SIGN_OFF_WORDS) {
    if (!folded.startsWith(word)) continue;
    const next = folded.charAt(word.length);
    if (next && !word.endsWith('.') && !/[\s:.,;-]/.test(next)) continue;
    if (foldText(raw.slice(0, word.length)) !== word) continue;
    return raw.slice(word.length).replace(/^[\s:.,;-]+/, '').trim();
  }
  return raw;
}

/**
 * An article code printed in brackets after a name: "Rebar B500B (RB-500B)" ->
 * {name: "Rebar B500B", code: "RB-500B"}. A code has at least one digit, so "(red)" is not one.
 * @param {unknown} text
 * @returns {{name: string, code: string}|null}
 */
export function splitBracketedCode(text) {
  const match = /^(.*?\S)\s*[([]\s*([\p{L}\p{N}][\p{L}\p{N}._/-]{0,38}[\p{L}\p{N}])\s*[)\]]$/u.exec(String(text ?? '').trim());
  if (!match || !/\p{N}/u.test(match[2])) return null;
  return { name: match[1], code: match[2] };
}

/**
 * Can this sign-off be the named person? The person's surname (the last full name part, or the
 * part before a comma: "Vogelsang, Katrin") must be written in full, in any order and with
 * diacritics folded, and every other name or initial on the sign-off must fit one of the person's
 * given names. "K. Vogelsang", "Vogelsang K." and "Katrin Vogelsang" fit "Katrin Vogelsang";
 * "T. Brzezina", "T. Vogelsang" and "K.V." do not.
 * @param {unknown} signer name as written in the sign-off
 * @param {unknown} person name of the person who has to sign
 * @returns {boolean}
 */
export function signerMatches(signer, person) {
  const raw = String(person ?? '');
  const comma = raw.indexOf(',');
  let surname = null;
  let given = [];
  if (comma >= 0) {
    const before = nameTokens(raw.slice(0, comma));
    surname = before.at(-1) ?? null;
    given = [...before.slice(0, -1), ...nameTokens(raw.slice(comma + 1))];
  } else {
    const parts = nameTokens(raw);
    const at = parts.findLastIndex((part) => part.length > 1);
    if (at >= 0) {
      surname = parts[at];
      given = parts.filter((_, index) => index !== at);
    }
  }
  if (!surname) return false;
  const signed = nameTokens(signer);
  const at = signed.indexOf(surname);
  if (at < 0) return false;
  const fits = (part, name) => (part.length === 1 || name.length === 1 ? part[0] === name[0] : part === name);
  return signed
    .filter((_, index) => index !== at)
    .every((part) => given.length === 0 || given.some((name) => fits(part, name)));
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
