export function isInternalSession(session: string): boolean {
  return /(?:^|:)(?:active-memory|graph-memory-writer|memory-writer|cron|heartbeat|dreaming)(?:$|[:_-])/.test(session);
}
