import type { DomainEvent, EventActor } from "./events.js";
import type { EventPublisher } from "./ports.js";

/**
 * The one place an actor is attached to a domain event (ADR 0010).
 *
 * An `EventPublisher` decorator: it stamps `actor` and `requestId` onto every
 * event and delegates to the publisher it wraps. This is what lets the actor
 * established at the HTTP edge reach the audit trail without any of the ~45 use
 * cases learning that actors exist — they publish events as they always have,
 * and the composition seam decides what those events are attributed to.
 *
 * It lives in the shared kernel because that is the only package every bounded
 * context already depends on, and because stamping is a property of the event
 * contract rather than of any one context.
 *
 * IT DOES NOT AUTHORIZE. Deciding whether this actor may perform this action is
 * ADR 0009's job and stays explicit at the API boundary. A permission check that
 * happened invisibly inside a publisher would be a permission check nobody can
 * find when it is wrong — and by the time an event is being published, the
 * change it describes has already been made.
 *
 * Existing fields win nothing here: the spread puts `actor`/`requestId` AFTER
 * `...event`, so a publisher upstream cannot pre-stamp an event with a different
 * actor and have it survive. The composition path owns attribution.
 */
export class ActorStampingPublisher implements EventPublisher {
  constructor(
    private readonly inner: EventPublisher,
    private readonly actor: EventActor,
    /** Absent for work that belongs to no request (a scheduled sweep). */
    private readonly requestId?: string,
  ) {}

  async publish(events: DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    return this.inner.publish(
      events.map((event) => ({
        ...event,
        actor: this.actor,
        ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      })),
    );
  }
}
