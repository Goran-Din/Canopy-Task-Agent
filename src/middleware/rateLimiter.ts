const userLastCall: Map<number, number> = new Map();
const RATE_LIMIT_MS = 3000;

export function isRateLimited(telegramId: number): boolean {
  const last = userLastCall.get(telegramId) || 0;
  const now = Date.now();
  if (now - last < RATE_LIMIT_MS) return true;
  userLastCall.set(telegramId, now);
  return false;
}
