/**
 * Loads the bundled fictional sample cases from samples/<id>/case.json.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DOCUMENT_TYPES } from './schema.mjs';

/**
 * @param {string} dir samples directory
 * @returns {Array<{id: string, title: string, summary: string, documents: Array<{id: string, type: string, name: string, text: string}>}>}
 */
export function loadSamples(dir) {
  const index = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
  return index.cases.map((id) => {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid sample id "${id}"`);
    const caseDir = path.join(dir, id);
    const manifest = JSON.parse(readFileSync(path.join(caseDir, 'case.json'), 'utf8'));
    return {
      id: manifest.id,
      title: manifest.title,
      summary: manifest.summary,
      documents: manifest.documents.map((doc) => {
        if (!DOCUMENT_TYPES.includes(doc.type)) throw new Error(`sample ${id}: unknown document type ${doc.type}`);
        return { id: doc.id, type: doc.type, name: doc.name, text: readFileSync(path.join(caseDir, doc.file), 'utf8') };
      }),
    };
  });
}
