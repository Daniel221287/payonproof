/**
 * Minimal .env loader. Values are never printed or logged; existing
 * environment variables always win over the file.
 */
import { existsSync, readFileSync } from 'node:fs';

/**
 * Parse KEY=VALUE lines. Supports `export KEY=...`, # comments, single and
 * double quotes (with \n, \", \\ escapes inside double quotes).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    let value;
    const doubleQuoted = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
    const singleQuoted = /^'([^']*)'/.exec(rest);
    if (doubleQuoted) {
      value = doubleQuoted[1].replace(/\\(n|r|t|"|\\)/g, (_, ch) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[ch]);
    } else if (singleQuoted) {
      value = singleQuoted[1];
    } else {
      value = rest.replace(/\s+#.*$/, '').trim();
    }
    values[key] = value;
  }
  return values;
}

/**
 * Load a .env file into `target` without overriding variables that are already set.
 * @param {string} filePath
 * @param {Record<string, string|undefined>} [target]
 * @returns {{found: boolean, loaded: string[], skipped: string[]}} variable NAMES only
 */
export function loadDotEnv(filePath, target = process.env) {
  if (!existsSync(filePath)) return { found: false, loaded: [], skipped: [] };
  const values = parseDotEnv(readFileSync(filePath, 'utf8'));
  const loaded = [];
  const skipped = [];
  for (const [key, value] of Object.entries(values)) {
    if (target[key] !== undefined) {
      skipped.push(key);
    } else {
      target[key] = value;
      loaded.push(key);
    }
  }
  return { found: true, loaded, skipped };
}
