// Session policies. Read and write are deliberately separate:
//   - isInternalSession  -> the turn is not a user turn: no recall, no persistence.
//   - isVerificationSession -> the turn may recall like any user turn but must not persist,
//     so an acceptance run cannot answer its own question from memory it just wrote.
// Name-based roles are a pragmatic signal, not an authorization decision, so verification roles
// are configurable (writer.excludeSessionPatterns) and never gate reads.
const SYSTEM_ROLES = [
  "active-memory",
  "graph-memory-writer",
  "memory-writer",
  "cron",
  "heartbeat",
  "dreaming",
];

const VERIFICATION_ROLES = [
  "probe",
  "acceptance",
  "verify",
  "verification",
  "diagnostics",
  "audit",
  "evaluation",
];

function rolePattern(roles: readonly string[]): RegExp {
  // `-`/`_`/`.` also delimit tokens so `memory-score-diagnostics-ready-20260909` is recognised.
  return new RegExp(`(?:^|[:_.-])(${roles.map((role) => role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:$|[:_.-])`);
}

const SYSTEM_PATTERN = rolePattern(SYSTEM_ROLES);
const VERIFICATION_PATTERN = rolePattern(VERIFICATION_ROLES);

export function isInternalSession(session: string): boolean {
  return SYSTEM_PATTERN.test(session);
}

/** Extra regexes come from config; invalid patterns are ignored rather than throwing. */
export function isVerificationSession(session: string, extraPatterns: readonly string[] = []): boolean {
  if (VERIFICATION_PATTERN.test(session)) return true;
  return extraPatterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(session);
    } catch {
      return false;
    }
  });
}
