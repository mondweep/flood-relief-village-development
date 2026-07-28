/**
 * Transactional outbox EventPublisher (ADR-006): writes domain events to the emitting
 * context's `<schema>.domain_events` table. `published_at` is left null — a separate
 * worker (Supabase Edge Function + cron, per ADR-006) fans events out and marks them
 * published; this class's only job is the durable, in-schema write.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DomainEvent, EventPublisher } from '../shared/index.js';

export interface DomainEventRow {
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly occurred_at: string;
}

/** Pure mapping: a DomainEvent to its outbox row shape. */
export function toDomainEventRow(event: DomainEvent): DomainEventRow {
  return {
    event_type: event.type,
    payload: event.payload,
    occurred_at: event.occurredAt.toISOString(),
  };
}

export class SupabaseEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SupabaseClient,
    private readonly schema: string,
  ) {}

  async publish(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;

    const rows = events.map(toDomainEventRow);
    const { error } = await this.client.schema(this.schema).from('domain_events').insert(rows);
    if (error) {
      throw new Error(
        `SupabaseEventPublisher: failed to insert into ${this.schema}.domain_events: ${error.message}`,
      );
    }
  }
}
