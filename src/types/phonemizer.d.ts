declare module 'phonemizer' {
  /** Converts text to IPA phonemes with eSpeak NG; returns one string per clause. */
  export function phonemize(text: string, language?: string): Promise<string[]>;
}
