const processedUpdates = new Set<number>();
const MAX_CACHE_SIZE = 1000;

export function isDuplicate(updateId: number): boolean {
  if (processedUpdates.has(updateId)) return true;
  processedUpdates.add(updateId);
  if (processedUpdates.size > MAX_CACHE_SIZE) {
    const first = processedUpdates.values().next().value;
    if (first !== undefined) processedUpdates.delete(first);
  }
  return false;
}
