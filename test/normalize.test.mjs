import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signerMatches, splitBracketedCode, stripSignOffWords } from '../src/normalize.mjs';

test('the sign-off word in front of a signer name is dropped, in all four languages', () => {
  const cases = {
    'unterschrieben K. Vogelsang': 'K. Vogelsang',
    'Unterschrieben von K. Vogelsang': 'K. Vogelsang',
    'gez. K. Vogelsang': 'K. Vogelsang',
    'signed K. Vogelsang': 'K. Vogelsang',
    'Signed by: J. Smith': 'J. Smith',
    'podpisano J. Kowalski': 'J. Kowalski',
    'Podpisał J. Kowalski': 'J. Kowalski',
    'підписано О. Шевченко': 'О. Шевченко',
    'K. Vogelsang': 'K. Vogelsang',
    'Signedson, Anna': 'Signedson, Anna',
    'Podpiskova M.': 'Podpiskova M.',
    '  Katrin Vogelsang ': 'Katrin Vogelsang',
    unterschrieben: '',
  };
  for (const [written, name] of Object.entries(cases)) assert.equal(stripSignOffWords(written), name, written);
  assert.equal(signerMatches(stripSignOffWords('unterschrieben K. Vogelsang'), 'Katrin Vogelsang'), true);
  assert.equal(signerMatches('unterschrieben K. Vogelsang', 'Katrin Vogelsang'), false, 'the matcher itself stays strict');
});

test('an article code printed in brackets after a name is recognised; words in brackets are not codes', () => {
  assert.deepEqual(splitBracketedCode('Rebar B500B (RB-500B)'), { name: 'Rebar B500B', code: 'RB-500B' });
  assert.deepEqual(splitBracketedCode('Ready-mix concrete C30/37 (RMC-C30)'), { name: 'Ready-mix concrete C30/37', code: 'RMC-C30' });
  assert.deepEqual(splitBracketedCode('Papa podkładowa [BSU-4]'), { name: 'Papa podkładowa', code: 'BSU-4' });
  assert.equal(splitBracketedCode('Membrane (red)'), null);
  assert.equal(splitBracketedCode('Rebar (12 mm)'), null, 'no spaces in a code');
  assert.equal(splitBracketedCode('Rebar B500B'), null);
  assert.equal(splitBracketedCode('(RB-500B)'), null, 'a name is needed before the code');
});
