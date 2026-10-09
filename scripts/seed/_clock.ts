/**
 * The seed's clock: CANON's events happen on CANON's dates (D006 shared 28 Sep 2025, read by Claude
 * 2 Oct, withdrawn 5 Oct; the plan confirmed 3 Sep; "today" 7 Oct 2025).
 *
 * The rows are written at those dates through the normal code, so every log row, ledger entry and
 * the log seal are made as they would have been then: nothing is rewritten afterwards. To do that
 * the seed swaps the process's `Date` for one that runs from a chosen moment, for the length of
 * `seedCase` only, and restores it afterwards. This lives in scripts/ (never imported by src/), so
 * the app and the CLI can't reach it: they always run on the real clock.
 *
 * The clock only moves forward, and keeps ticking at the real rate between `set` calls, so the
 * log's order is the order things were done.
 */

const RealDate = globalThis.Date;

export interface SeedClock {
  /** Move the clock forward to `iso`. Refuses to go back. */
  set(iso: string): void;
  /** The clock's time now (ms). */
  now(): number;
  /** Put the real `Date` back. */
  restore(): void;
}

/** Install a clock that starts at `startIso`. Call `restore()` when the seed is done. */
export function installSeedClock(startIso: string): SeedClock {
  if (globalThis.Date !== RealDate) throw new Error("A seed clock is already installed.");
  let offset = 0;
  const now = () => RealDate.now() + offset;
  const parse = (iso: string) => {
    const t = RealDate.parse(iso);
    if (Number.isNaN(t)) throw new Error(`Bad seed date: ${iso}`);
    return t;
  };
  const set = (iso: string) => {
    const target = parse(iso);
    if (target < now()) throw new Error(`The seed clock can't go back to ${iso}.`);
    offset = target - RealDate.now();
  };
  offset = parse(startIso) - RealDate.now();

  // A Date whose "now" is the seed's clock; everything else is the real Date.
  const SeedDate = function (this: unknown, ...args: unknown[]) {
    if (!new.target) return new RealDate(now()).toString();
    // deno-lint-ignore no-explicit-any
    return args.length ? new (RealDate as any)(...args) : new RealDate(now());
  } as unknown as DateConstructor;
  Object.setPrototypeOf(SeedDate, RealDate);
  (SeedDate as { prototype: Date }).prototype = RealDate.prototype;
  (SeedDate as { now: () => number }).now = now;
  globalThis.Date = SeedDate;

  return {
    set,
    now,
    restore: () => {
      globalThis.Date = RealDate;
    },
  };
}
