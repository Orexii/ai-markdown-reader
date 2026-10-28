import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { dictionaryFrom, normalizeNumber, pronounce, pronounceAsText, spell } from '../src/engine/pronounce';

test('acronyms are spelled with exact phonemes, including plurals and possessives', () => {
  assert.deepEqual(pronounce('ANF'), [{ phonemes: 'ˌeɪˌɛnˈɛf' }]);
  assert.deepEqual(pronounce('ADO'), [{ phonemes: spell('ADO') }]);
  assert.deepEqual(pronounce('IcM'), [{ phonemes: spell('ICM') }]);
  assert.deepEqual(pronounce('VMs'), [{ phonemes: 'vˌiːˈɛmz' }]);
  assert.deepEqual(pronounce("API's"), [{ phonemes: 'ˌeɪpˌiːˈaɪz' }]);
  assert.deepEqual(pronounce('JSON'), [{ text: 'JSON' }]);
  assert.deepEqual(pronounce('NASA'), [{ text: 'NASA' }]);
  assert.deepEqual(pronounce('Prod'), [{ text: 'Prod' }]);
  assert.equal(spell('ROZ', 'gb'), 'ˌɑːˌəʊzˈɛd');
});

test('identifiers become speakable parts', () => {
  assert.deepEqual(pronounce('ANFObservabilityDB'), [{ phonemes: spell('ANF') }, { text: 'Observability' }, { phonemes: spell('DB') }]);
  assert.deepEqual(pronounce('DataHarborKusto.kustoPermissions'), [{ text: 'Data Harbor Kusto dot kusto Permissions' }]);
  assert.deepEqual(pronounce('src/Deploy/main.ps1'), [{ text: 'src slash Deploy slash main dot ps 1' }]);
  assert.deepEqual(pronounce('snake_case_name'), [{ text: 'snake case name' }]);
  assert.deepEqual(pronounce('EC2'), [{ phonemes: spell('EC') }, { text: '2' }]);
});

test('numbers, money, times, ranges, versions and multipliers', () => {
  assert.equal(normalizeNumber('$12.50'), '12 dollars and 50 cents');
  assert.equal(normalizeNumber('$1'), '1 dollar');
  assert.equal(normalizeNumber('£3.01'), '3 pounds and 1 penny');
  assert.equal(normalizeNumber('10:30'), '10 30');
  assert.equal(normalizeNumber('9:05'), '9 oh 5');
  assert.equal(normalizeNumber('7:00'), "7 o'clock");
  assert.equal(normalizeNumber('2026'), '20 26');
  assert.equal(normalizeNumber('1900'), '19 hundred');
  assert.equal(normalizeNumber('2005'), '2005');
  assert.equal(normalizeNumber('1990s'), '19 90s');
  assert.equal(normalizeNumber('10-20'), '10 to 20');
  assert.equal(normalizeNumber('3.5x'), '3.5 times');
  assert.equal(normalizeNumber('v1.2.3'), 'version 1 point 2 point 3');
  assert.equal(normalizeNumber('1,234,567'), '1234567');
  assert.equal(normalizeNumber('~5'), 'about 5');
  assert.equal(normalizeNumber('hello'), undefined);
});

test('abbreviations and symbols are said as words', () => {
  assert.deepEqual(pronounce('e.g.'), [{ text: 'for example' }]);
  assert.deepEqual(pronounce('i.e.'), [{ text: 'that is' }]);
  assert.deepEqual(pronounce('&'), [{ text: 'and' }]);
  assert.deepEqual(pronounce('→'), [{ text: 'to' }]);
  assert.deepEqual(pronounce('C#'), [{ text: 'C sharp' }]);
});

test('the pronunciation dictionary supports text and IPA, case-insensitively', () => {
  const dictionary = dictionaryFrom({ Kusto: 'kuss toe', Rakeem: '/ɹɑːkˈiːm/', bad: 7, '': 'x' });
  assert.deepEqual(pronounce('Kusto', 'us', dictionary), [{ text: 'kuss toe' }]);
  assert.deepEqual(pronounce('kusto', 'us', dictionary), [{ text: 'kuss toe' }]);
  assert.deepEqual(pronounce('Rakeem', 'us', dictionary), [{ phonemes: 'ɹɑːkˈiːm' }]);
  assert.equal(dictionary.has('bad'), false);
  assert.equal(pronounceAsText('Rakeem', dictionary), 'Rakeem');
});

test('system voices get spaced letters instead of phonemes', () => {
  assert.equal(pronounceAsText('ANF'), 'A N F');
  assert.equal(pronounceAsText('VMs'), "V M's");
  assert.equal(pronounceAsText('ANFObservabilityDB'), 'A N F Observability D B');
  assert.equal(pronounceAsText('$5'), '5 dollars');
});

test('percentages and units after a number are said in full', () => {
  assert.equal(normalizeNumber('100%'), '100 percent');
  assert.equal(normalizeNumber('12.5%'), '12 point 5 percent');
  assert.equal(normalizeNumber('8kg'), '8 kilograms');
  assert.equal(normalizeNumber('1GB'), '1 gigabyte');
  assert.equal(normalizeNumber('100GiB'), '100 gibibytes');
  assert.equal(normalizeNumber('2.5GHz'), '2 point 5 gigahertz');
  assert.equal(normalizeNumber('80s'), undefined, 'a decade, not 80 seconds');
  assert.equal(normalizeNumber('5G'), undefined, 'a network, not 5 grams');
  const after = (word: string, previous: string) => pronounceAsText(word, new Map(), previous);
  assert.equal(after('kg', '8–11'), 'kilograms');
  assert.equal(after('lb', '17–23'), 'pounds', 'a range is plural');
  assert.equal(after('kg', '1'), 'kilogram');
  assert.equal(after('TiB', '4'), 'tebibytes');
  assert.equal(after('ms', '250'), 'milliseconds');
  assert.equal(after('kg', 'heavy'), 'kg', 'only after a number');
  assert.equal(after('in', '1'), 'in', '"1 in 5" is not inches');
  assert.equal(pronounceAsText('kg', new Map([['kg', 'keg']]), '3'), 'keg', 'the dictionary wins');
});

test('keyboard shortcuts name their keys, and arrows inside sentences are words', () => {
  assert.equal(pronounceAsText('Shift+←'), 'Shift plus left arrow');
  assert.equal(pronounceAsText('Ctrl+→'), 'control plus right arrow');
  assert.equal(pronounceAsText('Ctrl+Alt+P'), 'control plus Alt plus P');
  assert.equal(pronounceAsText('Cmd+Shift+↓'), 'command plus Shift plus down arrow');
  assert.equal(pronounceAsText('Esc'), 'escape');
  assert.equal(pronounceAsText('→'), 'to', 'as in "Settings → Extensions"');
  assert.equal(pronounceAsText('*'), 'times', 'kept only between numbers by the narration');
  assert.equal(pronounceAsText('C++'), 'C plus plus');
});
