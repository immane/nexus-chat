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
