import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted by UTF-16 code units (as in RFC 8785),
 * no whitespace, arrays keep their order, `undefined` object members omitted.
 * Two objects with the same content always produce the same string, whatever
 * order their keys were inserted in.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return serialize(value);
}

function serialize(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('cannot canonicalize a non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : serialize(item))).join(',')}]`;
      }
      const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(value[key])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`cannot canonicalize a ${typeof value}`);
  }
}

/**
 * SHA-256 as lowercase hex.
 * @param {string|Uint8Array} data
 * @returns {string}
 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * SHA-256 of the canonical JSON form of a value.
 * @param {unknown} value
 * @returns {string}
 */
export function hashCanonical(value) {
  return sha256Hex(canonicalJson(value));
}
