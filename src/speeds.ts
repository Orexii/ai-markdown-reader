/** Every speed the reader supports: quarter steps from a quarter of normal speed to five times. */
export const ALL_SPEEDS: readonly number[] = Array.from({ length: 20 }, (_, i) => (i + 1) / 4);
/** The short list offered unless more speeds are turned on (clearMarkdown.expandedSpeeds). */
export const BASIC_SPEEDS: readonly number[] = [0.5, 1, 1.5, 2];

/** The supported speed closest to a value (older versions saved other values). */
export function nearestSpeed(value: number): number {
  const wanted = Number.isFinite(value) ? value : 1;
  return Math.min(5, Math.max(0.25, Math.round(wanted * 4) / 4));
}

export const isSpeed = (value: unknown): value is number => typeof value === 'number' && ALL_SPEEDS.includes(value);

/** The speeds to offer: the short or the full list, plus the current speed if it is not in it. */
export function speedChoices(expanded: boolean, current: number): number[] {
  const list = [...(expanded ? ALL_SPEEDS : BASIC_SPEEDS)];
  if (isSpeed(current) && !list.includes(current)) list.push(current);
  return list.sort((a, b) => a - b);
}

export const formatSpeed = (speed: number) => `${Number(speed.toFixed(2))}×`;
