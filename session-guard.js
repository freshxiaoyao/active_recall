export function isInternalSession(session        )          {
  return /(?:^|:)active-memory(?:$|[:_-])|(?:^|:)(?:cron|heartbeat)(?:$|:)|(?:^|:)dreaming(?:$|[:_-])|(?:^|:)graph-memory-writer(?:$|[:_-])/.test(session);
}


//# sourceURL=C:\Users\lenovo\.openclaw\workspace\plugins\active_recall\session-guard.ts