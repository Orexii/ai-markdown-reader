// A TypeScript port of the word lookup in misaki (https://github.com/hexgrad/misaki, Apache-2.0),
// the grapheme-to-phoneme frontend Kokoro was trained with. Without a part-of-speech tagger,
// entries that depend on the tag use their default reading.

export type Entry = string | Record<string, string | null>;
export interface LexiconData { gold: Record<string, Entry>; silver: Record<string, Entry> }

const PRIMARY = 'ˈ';
const SECONDARY = 'ˌ';
const VOWELS = new Set('AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ');
const CONSONANTS = new Set('bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ');
const US_TAUS = new Set('AIOWYiuæɑəɛɪɹʊʌ');
const PUNCTUATION = new Set(';:,.!?—…');

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
const isAlpha = (word: string) => /^[A-Za-z]+$/.test(word);

/** Moves each stress mark to just before the vowel it stresses. */
function restress(phonemes: string): string {
  const chars = [...phonemes].map((ch, i) => ({ ch, at: i }));
  for (const item of chars) {
    if (item.ch !== PRIMARY && item.ch !== SECONDARY) continue;
    const vowel = chars.find(other => other.at >= item.at && VOWELS.has(other.ch));
    if (vowel) item.at = vowel.at - 0.5;
  }
  return chars.sort((a, b) => a.at - b.at).map(item => item.ch).join('');
}

export function applyStress(phonemes: string, stress: number | null): string {
  if (stress === null) return phonemes;
  const hasVowel = [...phonemes].some(ch => VOWELS.has(ch));
  const marked = phonemes.includes(PRIMARY) || phonemes.includes(SECONDARY);
  if (stress < -1) return phonemes.replaceAll(PRIMARY, '').replaceAll(SECONDARY, '');
  if (stress === -1 || ((stress === 0 || stress === -0.5) && phonemes.includes(PRIMARY))) {
    return phonemes.replaceAll(SECONDARY, '').replaceAll(PRIMARY, SECONDARY);
  }
  if ((stress === 0 || stress === 0.5 || stress === 1) && !marked) return hasVowel ? restress(SECONDARY + phonemes) : phonemes;
  if (stress >= 1 && !phonemes.includes(PRIMARY) && phonemes.includes(SECONDARY)) return phonemes.replaceAll(SECONDARY, PRIMARY);
  if (stress > 1 && !marked) return hasVowel ? restress(PRIMARY + phonemes) : phonemes;
  return phonemes;
}

/** Whether phonemes start with a vowel sound: true/false, or null before punctuation or at the end. */
export function startsWithVowel(phonemes: string | undefined): boolean | null | undefined {
  for (const ch of phonemes ?? '') {
    if (VOWELS.has(ch)) return true;
    if (CONSONANTS.has(ch)) return false;
    if (PUNCTUATION.has(ch)) return null;
  }
  return undefined;
}

function grow(entries: Record<string, Entry>): Map<string, Entry> {
  const map = new Map(Object.entries(entries));
  for (const [key, value] of Object.entries(entries)) {
    if (key.length < 2) continue;
    if (key === key.toLowerCase()) {
      if (key !== capitalize(key) && !map.has(capitalize(key))) map.set(capitalize(key), value);
    } else if (key === capitalize(key.toLowerCase()) && !map.has(key.toLowerCase())) {
      map.set(key.toLowerCase(), value);
    }
  }
  return map;
}

export interface Context {
  /** Whether the next word starts with a vowel sound; null at a phrase boundary or the end. */
  nextVowel: boolean | null;
  nextIsTo: boolean;
}

export class Lexicon {
  private readonly golds: Map<string, Entry>;
  private readonly silvers: Map<string, Entry>;

  constructor(data: LexiconData, private readonly british: boolean) {
    this.golds = grow(data.gold);
    this.silvers = grow(data.silver);
  }

  private choose(entry: Entry | undefined, context: Context): string | null | undefined {
    if (entry === undefined || typeof entry === 'string') return entry;
    if (context.nextVowel === null && 'None' in entry) return entry.None;
    return entry.DEFAULT;
  }

  /** Spells a word letter by letter with the lexicon's letter names (misaki get_NNP). */
  spell(word: string): string | undefined {
    const letters = [...word].filter(ch => /[A-Za-z]/.test(ch)).map(ch => this.golds.get(ch.toUpperCase()));
    if (!letters.length || letters.some(letter => typeof letter !== 'string')) return undefined;
    const joined = applyStress(letters.join(''), 0);
    const last = joined.lastIndexOf(SECONDARY);
    return last < 0 ? joined : `${joined.slice(0, last)}${PRIMARY}${joined.slice(last + 1)}`;
  }

  private special(word: string, context: Context): string | undefined {
    if (word === 'a' || word === 'A') return context.nextVowel === null && word === 'A' ? `${PRIMARY}A` : 'ɐ';
    if (word === 'an' || word === 'An') return 'ɐn';
    if (word === 'I') return `${SECONDARY}I`;
    if (word === 'to' || word === 'To') return context.nextVowel === null ? this.choose(this.golds.get('to'), context) ?? undefined : context.nextVowel ? 'tʊ' : 'tə';
    if (word === 'in' || word === 'In') return context.nextVowel === null ? `${PRIMARY}ɪn` : 'ɪn';
    if (word === 'the' || word === 'The') return context.nextVowel ? 'ði' : 'ðə';
    if (word === 'used' || word === 'Used') {
      const entry = this.golds.get('used');
      if (entry && typeof entry !== 'string') return (context.nextIsTo ? entry.VBD : entry.DEFAULT) ?? undefined;
    }
    return undefined;
  }

  private known(word: string): boolean {
    if (this.golds.has(word) || this.silvers.has(word)) return true;
    if (!isAlpha(word)) return false;
    if (word.length === 1) return true;
    if (word === word.toUpperCase() && this.golds.has(word.toLowerCase())) return true;
    return word.slice(1) === word.slice(1).toUpperCase();
  }

  private lookup(word: string, context: Context, stress: number | null = null): string | undefined {
    let key = word;
    let proper = false;
    if (key === key.toUpperCase() && !this.golds.has(key)) {
      key = key.toLowerCase();
      proper = false;
    }
    let phonemes = this.choose(this.golds.get(key), context);
    if (phonemes === undefined && !proper) phonemes = this.choose(this.silvers.get(key), context);
    if (phonemes === undefined || phonemes === null) return this.spell(key);
    return applyStress(phonemes, stress);
  }

  private plural(stem: string | undefined): string | undefined {
    if (!stem) return undefined;
    const last = stem.at(-1)!;
    if ('ptkfθ'.includes(last)) return `${stem}s`;
    if ('szʃʒʧʤ'.includes(last)) return `${stem}${this.british ? 'ɪ' : 'ᵻ'}z`;
    return `${stem}z`;
  }

  private past(stem: string | undefined): string | undefined {
    if (!stem) return undefined;
    const last = stem.at(-1)!;
    if ('pkfθʃsʧ'.includes(last)) return `${stem}t`;
    if (last === 'd') return `${stem}${this.british ? 'ɪ' : 'ᵻ'}d`;
    if (last !== 't') return `${stem}d`;
    if (this.british || stem.length < 2) return `${stem}ɪd`;
    if (US_TAUS.has(stem.at(-2)!)) return `${stem.slice(0, -1)}ɾᵻd`;
    return `${stem}ᵻd`;
  }

  private progressive(stem: string | undefined): string | undefined {
    if (!stem) return undefined;
    if (this.british) return 'əː'.includes(stem.at(-1)!) ? undefined : `${stem}ɪŋ`;
    if (stem.length > 1 && stem.at(-1) === 't' && US_TAUS.has(stem.at(-2)!)) return `${stem.slice(0, -1)}ɾɪŋ`;
    return `${stem}ɪŋ`;
  }

  private stemS(word: string, context: Context): string | undefined {
    if (word.length < 3 || !word.endsWith('s')) return undefined;
    let stem: string;
    if (!word.endsWith('ss') && this.known(word.slice(0, -1))) stem = word.slice(0, -1);
    else if ((word.endsWith("'s") || (word.length > 4 && word.endsWith('es') && !word.endsWith('ies'))) && this.known(word.slice(0, -2))) stem = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith('ies') && this.known(`${word.slice(0, -3)}y`)) stem = `${word.slice(0, -3)}y`;
    else return undefined;
    return this.plural(this.lookup(stem, context));
  }

  private stemEd(word: string, context: Context): string | undefined {
    if (word.length < 4 || !word.endsWith('d')) return undefined;
    let stem: string;
    if (!word.endsWith('dd') && this.known(word.slice(0, -1))) stem = word.slice(0, -1);
    else if (word.length > 4 && word.endsWith('ed') && !word.endsWith('eed') && this.known(word.slice(0, -2))) stem = word.slice(0, -2);
    else return undefined;
    return this.past(this.lookup(stem, context));
  }

  private stemIng(word: string, context: Context): string | undefined {
    if (word.length < 5 || !word.endsWith('ing')) return undefined;
    let stem: string;
    if (word.length > 5 && this.known(word.slice(0, -3))) stem = word.slice(0, -3);
    else if (this.known(`${word.slice(0, -3)}e`)) stem = `${word.slice(0, -3)}e`;
    else if (word.length > 5 && /([bcdgklmnprstvxz])\1ing$|cking$/.test(word) && this.known(word.slice(0, -4))) stem = word.slice(0, -4);
    else return undefined;
    return this.progressive(this.lookup(stem, context, 0.5));
  }

  /** Phonemes for one word, or undefined when the lexicon does not know it. */
  word(text: string, context: Context): string | undefined {
    let word = text.replace(/[‘’]/g, "'");
    const special = this.special(word, context);
    if (special !== undefined) return special;
    const lower = word.toLowerCase();
    if (word.length > 1 && isAlpha(word.replaceAll("'", '')) && word !== lower && !this.golds.has(word) && !this.silvers.has(word) &&
      (word === word.toUpperCase() || word.slice(1) === word.slice(1).toLowerCase()) &&
      (this.golds.has(lower) || this.silvers.has(lower) || [this.stemS, this.stemEd, this.stemIng].some(stem => stem.call(this, lower, context)))) {
      word = lower;
    }
    if (this.known(word)) return this.lookup(word, context);
    if (word.endsWith("s'") && this.known(`${word.slice(0, -2)}'s`)) return this.lookup(`${word.slice(0, -2)}'s`, context);
    if (word.endsWith("'") && this.known(word.slice(0, -1))) return this.lookup(word.slice(0, -1), context);
    return this.stemS(word, context) ?? this.stemEd(word, context) ?? this.stemIng(word, context);
  }
}
