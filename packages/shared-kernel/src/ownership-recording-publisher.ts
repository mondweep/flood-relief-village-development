import type { DomainEvent } from "./events.js";
import type { EventPublisher } from "./ports.js";
import type { OwnableRecordType, OwnershipRegistry } from "./authorization.js";

/**
 * Records who created a record, from the creation event itself (ADR 0009).
 *
 * ADR 0009 keeps ownership out of the aggregates — `Village` and `Beneficiary`
 * do not know that users exist — which leaves the question of *where* the
 * ownership row gets written. Doing it in each creating use case would mean ~10
 * use cases growing a second obligation they can silently forget, and the
 * failure mode of forgetting is invisible: the record saves fine and its author
 * simply cannot edit it later, which reads as a permissions bug rather than a
 * missing write.
 *
 * So it is done here, off the event stream. A creating use case cannot publish
 * `village.registered.v1` without this decorator seeing it, which is exactly the
 * mitigation ADR 0009 names for the join table drifting from the records it
 * describes.
 *
 * ORDERING. This must sit INSIDE `ActorStampingPublisher`, i.e.
 * `new ActorStampingPublisher(new OwnershipRecordingPublisher(bus, …), actor)`,
 * because it reads `event.actor` and the stamp is what puts it there. Wired the
 * other way round it sees unstamped events, records nothing, and every test
 * about ownership still passes while every real edit is refused — hence the
 * guard test that asserts this decorator sees a stamped event.
 *
 * NOT an authorization check, despite living next to one. It records a fact
 * about the past; it never decides anything. `authorizePlatform` does the
 * deciding, at the use-case boundary, where a reader looking for a permission
 * rule will actually look.
 */

/**
 * Creation events, and where each carries its new record's id.
 *
 * Only the five `OwnableRecordType`s appear. Notably absent:
 * `beneficiary.registered.v1` and `project.sanctioned.v1` — ownership widens
 * edit rights, and neither of those records should become editable by virtue of
 * having been typed in. A beneficiary's record is not the property of whoever
 * entered it.
 */
export const OWNERSHIP_EVENT_MAP: Readonly<
  Record<string, { readonly recordType: OwnableRecordType; readonly idKey: string }>
> = {
  "village.registered.v1": { recordType: "village", idKey: "villageId" },
  "issue.reported.v1": { recordType: "issue", idKey: "issueId" },
  "volunteer.registered.v1": { recordType: "volunteer", idKey: "volunteerId" },
  "plan.created.v1": { recordType: "plan", idKey: "planId" },
  "signal.detected.v1": { recordType: "signal", idKey: "signalId" },
};

export class OwnershipRecordingPublisher implements EventPublisher {
  constructor(
    private readonly inner: EventPublisher,
    private readonly ownership: OwnershipRegistry,
  ) {}

  async publish(events: DomainEvent[]): Promise<void> {
    if (events.length === 0) return;

    // Recorded BEFORE delegating, and awaited rather than fired off: the caller
    // is about to return a 201 whose id the client may immediately PATCH, so the
    // ownership row has to exist by the time the response is written. A
    // background write would lose that race intermittently — the worst kind of
    // permissions bug, since it reproduces on a fast client and not on a slow one.
    for (const event of events) {
      const mapping = OWNERSHIP_EVENT_MAP[event.name];
      if (mapping === undefined) continue;
      // Only a named person can own something. `system` and `anonymous` actors,
      // and an unstamped event, all mean there is nobody to record — writing a
      // row anyway would invent an owner.
      if (event.actor?.kind !== "user") continue;
      const recordId = event.payload[mapping.idKey];
      if (typeof recordId !== "string" || recordId.length === 0) continue;
      await this.ownership.record({
        recordType: mapping.recordType,
        recordId,
        ownerId: event.actor.id,
      });
    }

    return this.inner.publish(events);
  }
}
