import { describe, expect, it } from 'vitest';
import { domainEvent } from '../shared/index.js';
import { toDomainEventRow } from './supabase-event-publisher.js';

describe('toDomainEventRow', () => {
  it('maps a domain event to its outbox row shape', () => {
    const at = new Date('2026-07-28T09:00:00.000Z');
    const event = domainEvent('VillageRegistered', at, { villageId: 'v1' });

    expect(toDomainEventRow(event)).toEqual({
      event_type: 'VillageRegistered',
      payload: { villageId: 'v1' },
      occurred_at: '2026-07-28T09:00:00.000Z',
    });
  });

  it('preserves the full payload verbatim', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const payload = { a: 1, b: 'two', c: [1, 2, 3], d: { nested: true } };
    const event = domainEvent('Something', at, payload);

    expect(toDomainEventRow(event).payload).toEqual(payload);
  });
});
