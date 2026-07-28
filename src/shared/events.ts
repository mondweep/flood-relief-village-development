/** Base shape of every cross-context domain event (ADR-006, PRD §4.3). */
export interface DomainEvent {
  readonly type: string;
  readonly occurredAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
}

export const domainEvent = (
  type: string,
  occurredAt: Date,
  payload: Readonly<Record<string, unknown>>,
): DomainEvent => ({ type, occurredAt, payload });
