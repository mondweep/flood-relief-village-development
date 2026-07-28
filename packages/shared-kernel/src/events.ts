export interface DomainEvent<TPayload = Record<string, unknown>> {
  /** Versioned event name, e.g. "village.registered.v1" */
  readonly name: string;
  /** ISO-8601 instant the event occurred */
  readonly occurredAt: string;
  /** Published-language payload: primitives and identifiers only */
  readonly payload: TPayload;
}
