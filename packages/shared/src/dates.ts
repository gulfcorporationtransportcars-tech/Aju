/** Days from `now` until `date` (negative = already past). Calendar days, UAE time. */
export function daysUntil(date: Date, now: Date = new Date()): number {
  const tz = "Asia/Dubai";
  const fmt = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(x); // YYYY-MM-DD
  const a = Date.parse(fmt(now));
  const b = Date.parse(fmt(date));
  return Math.round((b - a) / 86_400_000);
}

export const EXPIRY_ALERT_DAYS = [90, 60, 30, 7, 0] as const;

/** Which alert (if any) is due now. Returns the most urgent threshold reached. */
export function dueExpiryAlert(expiresOn: Date, alreadySent: number[], now: Date = new Date()): number | null {
  const left = daysUntil(expiresOn, now);
  const reached = EXPIRY_ALERT_DAYS.filter((t) => left <= t);
  if (reached.length === 0) return null;
  const mostUrgent = Math.min(...reached);
  return alreadySent.includes(mostUrgent) ? null : mostUrgent;
}
