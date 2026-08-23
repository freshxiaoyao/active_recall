export function isInternalSession(session: string): boolean {
  return /(?:^|:)active-memory(?:$|[:_-])|(?:^|:)(?:cron|heartbeat)(?:$|:)|(?:^|:)dreaming(?:$|[:_-])|(?:^|:)graph-memory-writer(?:$|[:_-])/.test(session);
}
