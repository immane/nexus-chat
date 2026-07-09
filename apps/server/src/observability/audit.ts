/**
 * Audit Event Logger
 *
 * Provides an append-only in-memory audit trail for security-relevant actions.
 * Used by domain services (auth, workspace, bot, attachments) and WS gateway.
 *
 * Current Use Cases (Phase 1):
 * - auth.register, auth.login, auth.refresh_reuse_detected
 * - workspace.member_added, channel.member_added, channel.mode_created_e2e
 * - bot.installed, attachment.download_url_issued
 * - message.sent (from WS gateway)
 *
 * Does NOT:
 * - Persist across restarts (Phase 1 in-memory; production target is append-only DB table)
 * - Include PII in metadata (intentionally minimal)
 *
 * Future Evolution:
 * - Replace with structured logging to the audit_logs PostgreSQL table
 * - Add retention policy and export API for GDPR compliance
 */
export interface AuditEvent {
  type: string;
  actor: string;
  target?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export const auditEvents: AuditEvent[] = [];

export const writeAuditEvent = (event: Omit<AuditEvent, "timestamp">): void => {
  auditEvents.push({ ...event, timestamp: new Date().toISOString() });
};

export const getAuditEvents = (): AuditEvent[] => [...auditEvents];
