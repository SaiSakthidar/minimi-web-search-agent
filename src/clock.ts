// Single source of "now". Everything that stamps or reasons about dates calls
// now(), so AGENT_NOW (or POST /api/clock) can replay a demo on any day.

let override: Date | null = null;

export function setOverride(iso: string | null): void {
  if (iso === null) { override = null; return; }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid clock override: ${iso}`);
  override = d;
}

export function now(): Date {
  if (override) return new Date(override);
  const env = process.env.AGENT_NOW;
  if (env) {
    const d = new Date(env);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** "YYYY-MM-DD" in the process's local timezone. */
export function dayKey(d: Date | string): string {
  const x = typeof d === "string" ? new Date(d) : d;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}
