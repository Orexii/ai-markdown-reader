export type Segment = { text: string } | { phonemes: string };
export type Accent = 'us' | 'gb';

// Letter names as [onset, nucleus...] so the stress mark lands before the vowel, as eSpeak writes it.
const LETTERS: Record<string, [string, string]> = {
  A: ['', 'eɪ'], B: ['b', 'iː'], C: ['s', 'iː'], D: ['d', 'iː'], E: ['', 'iː'], F: ['', 'ɛf'], G: ['dʒ', 'iː'],
  H: ['', 'eɪtʃ'], I: ['', 'aɪ'], J: ['dʒ', 'eɪ'], K: ['k', 'eɪ'], L: ['', 'ɛl'], M: ['', 'ɛm'], N: ['', 'ɛn'],
  O: ['', 'oʊ'], P: ['p', 'iː'], Q: ['kj', 'uː'], R: ['', 'ɑːɹ'], S: ['', 'ɛs'], T: ['t', 'iː'], U: ['j', 'uː'],
  V: ['v', 'iː'], W: ['d', 'ʌbəljuː'], X: ['', 'ɛks'], Y: ['w', 'aɪ'], Z: ['z', 'iː']
};
const BRITISH: Record<string, [string, string]> = { O: ['', 'əʊ'], R: ['', 'ɑː'], Z: ['z', 'ɛd'] };

/** Upper-case words that are normally pronounced as words rather than spelled out. */
const WORD_ACRONYMS = new Set([
  'NASA', 'NATO', 'JSON', 'JSONL', 'YAML', 'TOML', 'REST', 'CRUD', 'RAM', 'ROM', 'LAN', 'WAN', 'GIF', 'JPEG',
  'SCSI', 'POSIX', 'CORS', 'ASCII', 'AJAX', 'WASM', 'CAPTCHA', 'LINQ', 'MAUI', 'CUDA', 'OLAP', 'SIM', 'PIN',
  'LASER', 'RADAR', 'SONAR', 'UNESCO', 'UNICEF', 'FIFO', 'LIFO', 'WYSIWYG', 'NAND', 'SKU', 'SWOT', 'OKR',
  'SaaS', 'PaaS', 'IaaS', 'DAX', 'DAG', 'SOAP', 'SAML', 'SCIM', 'MIME', 'TOTP', 'FIDO', 'GUID', 'OK', 'TODO'
]);

const BUILTIN: Record<string, string> = {
  OAuth: 'oh auth', iOS: 'eye oh ess', macOS: 'mac oh ess', iPadOS: 'eye pad oh ess', PostgreSQL: 'post gress Q L',
  MySQL: 'my S Q L', SQLite: 'S Q lite', NuGet: 'new get', kubectl: 'kube control', nginx: 'engine x',
  GUID: 'goo id', 'C#': 'C sharp', 'F#': 'F sharp', 'C++': 'C plus plus', '.NET': 'dot net', README: 'read me',
  stdin: 'standard in', stdout: 'standard out', stderr: 'standard error', regex: 'rej ex', TODO: 'to do',
  JSONL: 'jason L', npm: 'N P M', pnpm: 'P N P M', WinGet: 'win get', winget: 'win get', vs: 'versus',
  Ctrl: 'control', Cmd: 'command', Esc: 'escape', PgUp: 'page up', PgDn: 'page down'
};

const ABBREVIATIONS: Record<string, string> = {
  'e.g.': 'for example', 'i.e.': 'that is', 'etc.': 'et cetera', 'vs.': 'versus', 'approx.': 'approximately',
  'cf.': 'compare', 'mr.': 'mister', 'mrs.': 'missus', 'ms.': 'miss', 'dr.': 'doctor', 'no.': 'number',
  'w/': 'with', 'w/o': 'without'
};

const SYMBOLS: Record<string, string> = {
  '&': 'and', '+': 'plus', '=': 'equals', '%': 'percent', $: 'dollars', '#': 'number', '@': 'at',
  '<': 'less than', '>': 'greater than', '→': 'to', '->': 'to', '=>': 'to', '<-': 'from', '×': 'times',
  '~': 'about', '≈': 'about', '±': 'plus or minus', '/': 'slash', '↑': 'up', '↓': 'down', '←': 'back',
  // Only reaches here between numbers: elsewhere an asterisk is Markdown and is not spoken.
  '*': 'times'
};

/** Arrow and key symbols as key names, for keyboard shortcuts such as Shift+← or <kbd>→</kbd>. */
export const KEY_NAMES: Record<string, string> = {
  '←': 'left arrow', '→': 'right arrow', '↑': 'up arrow', '↓': 'down arrow', '⌘': 'command', '⌥': 'option', '⇧': 'shift', '⏎': 'enter', '↵': 'enter'
};

const SEPARATORS: Record<string, string> = {
  '.': 'dot', '/': 'slash', '\\': 'backslash', '@': 'at', '+': 'plus', '=': 'equals', '#': 'hash', '_': '', '-': '', ':': ''
};

export function spell(letters: string, accent: Accent = 'us', plural = false): string {
  const chars = [...letters.toUpperCase()].filter(ch => LETTERS[ch]);
  const parts = chars.map((ch, i) => {
    const [onset, rest] = (accent === 'gb' ? BRITISH[ch] : undefined) ?? LETTERS[ch]!;
    return `${onset}${i === chars.length - 1 ? 'ˈ' : 'ˌ'}${rest}`;
  });
  let result = parts.join('');
  if (plural) result += /[sxz]$|tʃ$/.test(LETTERS[chars.at(-1) ?? 'A']![1]) ? 'ɪz' : 'z';
  return result;
}

function isAcronym(word: string): boolean {
  if (WORD_ACRONYMS.has(word)) return false;
  if (/^[A-Z]{2,6}$/.test(word)) return true;
  // Short mixed-case acronyms such as IcM, PhD or IoT.
  return /^[A-Z][A-Za-z]{1,3}$/.test(word) && (word.match(/[A-Z]/g) ?? []).length >= 2 && !/^[A-Z][a-z]+$/.test(word);
}

function money(symbol: string, amount: string): string {
  const unit = symbol === '$' ? 'dollar' : symbol === '£' ? 'pound' : 'euro';
  const [whole, fraction] = amount.replace(/,/g, '').split('.');
  const units = `${whole} ${unit}${whole === '1' ? '' : 's'}`;
  if (!fraction) return units;
  const cents = parseInt(fraction.padEnd(2, '0').slice(0, 2), 10);
  const coin = symbol === '£' ? (cents === 1 ? 'penny' : 'pence') : cents === 1 ? 'cent' : 'cents';
  return cents ? `${units} and ${cents} ${coin}` : units;
}

function year(value: string): string {
  const number = parseInt(value.slice(0, 4), 10);
  const suffix = value.endsWith('s') ? 's' : '';
  if (number < 1100 || number > 2099 || number % 1000 < 10) return value;
  const left = value.slice(0, 2);
  const right = parseInt(value.slice(2, 4), 10);
  if (number % 1000 >= 100 && right === 0) return `${left} hundred${suffix}`;
  if (number % 1000 >= 100 && right < 10) return `${left} oh ${right}${suffix}`;
  return `${left} ${right}${suffix}`;
}

/** Units said in full after a number, as [plural, singular]. Single letters are only units after a number. */
const UNITS: Record<string, [string, string]> = {
  kg: ['kilograms', 'kilogram'], g: ['grams', 'gram'], mg: ['milligrams', 'milligram'], lb: ['pounds', 'pound'],
  lbs: ['pounds', 'pound'], oz: ['ounces', 'ounce'], km: ['kilometers', 'kilometer'], m: ['meters', 'meter'],
  cm: ['centimeters', 'centimeter'], mm: ['millimeters', 'millimeter'], mi: ['miles', 'mile'], ft: ['feet', 'foot'],
  mph: ['miles per hour', 'mile per hour'], ml: ['milliliters', 'milliliter'], mL: ['milliliters', 'milliliter'],
  h: ['hours', 'hour'], hr: ['hours', 'hour'], hrs: ['hours', 'hour'], min: ['minutes', 'minute'], s: ['seconds', 'second'],
  sec: ['seconds', 'second'], ms: ['milliseconds', 'millisecond'], 'µs': ['microseconds', 'microsecond'], ns: ['nanoseconds', 'nanosecond'],
  KB: ['kilobytes', 'kilobyte'], MB: ['megabytes', 'megabyte'], GB: ['gigabytes', 'gigabyte'], TB: ['terabytes', 'terabyte'],
  PB: ['petabytes', 'petabyte'], KiB: ['kibibytes', 'kibibyte'], MiB: ['mebibytes', 'mebibyte'], GiB: ['gibibytes', 'gibibyte'],
  TiB: ['tebibytes', 'tebibyte'], PiB: ['pebibytes', 'pebibyte'], Kbps: ['kilobits per second', 'kilobit per second'],
  Mbps: ['megabits per second', 'megabit per second'], Gbps: ['gigabits per second', 'gigabit per second'],
  Hz: ['hertz', 'hertz'], kHz: ['kilohertz', 'kilohertz'], MHz: ['megahertz', 'megahertz'], GHz: ['gigahertz', 'gigahertz'],
  '°C': ['degrees Celsius', 'degree Celsius'], '°F': ['degrees Fahrenheit', 'degree Fahrenheit']
};
/** Units that are unambiguous when written straight after a number, as in 8kg or 100GiB ("80s" and "5G" are not). */
const ATTACHED_UNITS = new Set(Object.keys(UNITS).filter(unit => unit.length > 1 && !['mi', 'ml', 'mL', 'min', 'sec'].includes(unit)));

function unitName(unit: string, amount: string): string | undefined {
  const names = UNITS[unit];
  return names && (amount.replace(/,/g, '') === '1' ? names[1] : names[0]);
}

/** Normalizes numbers, money, times and ranges to words eSpeak pronounces naturally. */
export function normalizeNumber(word: string): string | undefined {
  let match: RegExpExecArray | null;
  if ((match = /^(\d[\d,]*(?:\.\d+)?)([A-Za-zµ°]+)$/.exec(word)) && ATTACHED_UNITS.has(match[2]!)) {
    return `${match[1]!.replace(/,/g, '').split('.').join(' point ')} ${unitName(match[2]!, match[1]!)}`;
  }
  if ((match = /^([$£€])(\d[\d,]*(?:\.\d+)?)$/.exec(word))) return money(match[1]!, match[2]!);
  if ((match = /^(\d{1,2}):(\d{2})$/.exec(word))) {
    const minutes = Number(match[2]);
    return minutes === 0 ? `${Number(match[1])} o'clock` : minutes < 10 ? `${Number(match[1])} oh ${minutes}` : `${Number(match[1])} ${minutes}`;
  }
  if (/^\d{4}s?$/.test(word)) return year(word);
  if ((match = /^(\d[\d,]*)[-–](\d[\d,]*)$/.exec(word))) return `${match[1]!.replace(/,/g, '')} to ${match[2]!.replace(/,/g, '')}`;
  if ((match = /^(\d+(?:\.\d+)?)[xX]$/.exec(word))) return `${match[1]} times`;
  if ((match = /^[vV](\d+(?:\.\d+){0,3})$/.exec(word))) return `version ${match[1]!.split('.').join(' point ')}`;
  if ((match = /^~(\d.*)$/.exec(word))) return `about ${match[1]}`;
  if ((match = /^(\d[\d,]*(?:\.\d+)?)%$/.exec(word))) return `${match[1]!.replace(/,/g, '').split('.').join(' point ')} percent`;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(word)) return word.replace(/,/g, '');
  return undefined;
}

function identifierParts(word: string): string[] {
  return word.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+(?:\.\d+)*|[^A-Za-z\d]/g) ?? [word];
}

function looksLikeIdentifier(word: string): boolean {
  return /[a-z][A-Z]|[A-Z]{2,}[a-z]|[A-Za-z\d][._/\\@#+=][A-Za-z\d]|^[._/]/.test(word) && !/^https?:/i.test(word);
}

function mergeText(segments: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    if ('text' in segment && !segment.text.trim()) continue;
    const previous = merged.at(-1);
    if ('text' in segment && previous && 'text' in previous) previous.text = `${previous.text} ${segment.text}`;
    else if (!('text' in segment) || segment.text) merged.push({ ...segment });
  }
  return merged;
}

/**
 * Converts one display word into pronunciation segments: plain text for eSpeak, or exact
 * phonemes for spelled acronyms and IPA dictionary entries. With textOnly, spelled acronyms
 * become spaced letters so system voices can say them.
 */
export function pronounce(word: string, accent: Accent = 'us', dictionary: ReadonlyMap<string, string> = new Map(), textOnly = false,
  previous?: string): Segment[] {
  const value = word.trim();
  if (!value) return [];
  // A unit after a number: "8–11 kg" is "8 to 11 kilograms", "1 GB" is "1 gigabyte".
  const amount = previous?.trim().match(/(\d[\d,]*(?:\.\d+)?)\)?$/)?.[1];
  if (amount !== undefined && UNITS[value] && !dictionary.has(value)) return [{ text: unitName(value, /[-–]/.test(previous!) ? '2' : amount)! }];
  const letters = (text: string, plural = false): Segment => textOnly
    ? { text: `${[...text.toUpperCase()].join(' ')}${plural ? "'s" : ''}` }
    : { phonemes: spell(text, accent, plural) };
  const custom = dictionary.get(value) ?? dictionary.get(value.toLowerCase());
  if (custom !== undefined) {
    const ipa = /^\/(.+)\/$/.exec(custom.trim());
    if (!ipa) return [{ text: custom }];
    return textOnly ? [{ text: value }] : [{ phonemes: ipa[1]! }];
  }
  if (BUILTIN[value]) return [{ text: BUILTIN[value]! }];
  const abbreviation = ABBREVIATIONS[value.toLowerCase()];
  if (abbreviation) return [{ text: abbreviation }];
  if (SYMBOLS[value]) return [{ text: SYMBOLS[value]! }];
  const number = normalizeNumber(value);
  if (number !== undefined) return [{ text: number }];

  const possessive = /^([A-Z][A-Za-z]{1,5})(?:'s|’s|s)$/.exec(value);
  if (possessive && isAcronym(possessive[1]!)) return [letters(possessive[1]!, true)];
  if (isAcronym(value)) return [letters(value)];
  // Letter and digit names such as EC2, S3 or M365.
  const coded = /^([A-Z]{1,4})(\d+)$/.exec(value);
  if (coded) return [letters(coded[1]!), { text: coded[2]! }];

  // Keyboard shortcuts such as Ctrl+Shift+→: arrows and symbols are key names here.
  if (/^[A-Za-z]+(?:\+[A-Za-z]+)*\+[A-Za-z0-9←→↑↓⌘⌥⇧⏎↵]$/.test(value) || /^(?:[A-Za-z]+\+)+[←→↑↓]$/.test(value)) {
    return mergeText(value.split('+').flatMap((key, k): Segment[] => [
      ...(k ? [{ text: 'plus' }] : []), KEY_NAMES[key] ? { text: KEY_NAMES[key]! } : BUILTIN[key] ? { text: BUILTIN[key]! } : isAcronym(key) && key.length > 1 ? letters(key) : { text: key }
    ]));
  }
  if (!looksLikeIdentifier(value)) return [{ text: value }];
  const segments: Segment[] = [];
  for (const part of identifierParts(value)) {
    if (/^[A-Za-z]+$/.test(part)) {
      if (BUILTIN[part]) segments.push({ text: BUILTIN[part]! });
      else if (isAcronym(part)) segments.push(letters(part));
      else segments.push({ text: part });
    } else if (/^\d/.test(part)) {
      segments.push({ text: part.split('.').join(' point ') });
    } else if (SEPARATORS[part] !== undefined) {
      segments.push({ text: SEPARATORS[part]! });
    }
  }
  return mergeText(segments);
}

/** Plain-text rendering for system voices, which cannot take phoneme input. */
export function pronounceAsText(word: string, dictionary: ReadonlyMap<string, string> = new Map(), previous?: string): string {
  return pronounce(word, 'us', dictionary, true, previous).map(segment => 'text' in segment ? segment.text : '').join(' ').trim();
}

/** Builds a pronunciation dictionary from the user setting, ignoring invalid entries. */
export function dictionaryFrom(setting: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!setting || typeof setting !== 'object') return result;
  for (const [key, value] of Object.entries(setting)) {
    if (typeof value === 'string' && key.trim() && value.trim()) {
      result.set(key.trim(), value.trim());
      if (!result.has(key.trim().toLowerCase())) result.set(key.trim().toLowerCase(), value.trim());
    }
  }
  return result;
}
