import { describe, expect, it, vi } from "vitest";
import { ActorStampingPublisher } from "../src/actor-stamping-publisher.js";
import { anonymousActor, systemActor, userActor, type DomainEvent } from "../src/events.js";
import type { OwnershipRegistry } from "../src/authorization.js";
import { OWNERSHIP_EVENT_MAP, OwnershipRecordingPublisher } from "../src/ownership-recording-publisher.js";
import type { EventPublisher } from "../src/ports.js";

function fakeOwnership(): OwnershipRegistry & { record: ReturnType<typeof vi.fn> } {
  return {
    record: vi.fn(async () => undefined),
    isOwner: vi.fn(async () => false),
  } as unknown as OwnershipRegistry & { record: ReturnType<typeof vi.fn> };
}

function fakeInner(): EventPublisher & { publish: ReturnType<typeof vi.fn> } {
  return { publish: vi.fn(async () => undefined) };
}

const ALICE = userActor({ id: "user-alice", email: "alice@example.org", role: "citizen" });

function villageRegistered(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    name: "village.registered.v1",
    occurredAt: "2026-07-29T10:00:00.000Z",
    payload: { villageId: "village-abc", name: "Rampur" },
    actor: ALICE,
    ...overrides,
  };
}

describe("OwnershipRecordingPublisher", () => {
  it("records the publishing user as the owner of a newly created record", async () => {
    const ownership = fakeOwnership();
    const inner = fakeInner();

    await new OwnershipRecordingPublisher(inner, ownership).publish([villageRegistered()]);

    expect(ownership.record).toHaveBeenCalledWith({
      recordType: "village",
      recordId: "village-abc",
      ownerId: "user-alice",
    });
  });

  it("still delivers every event to the publisher it wraps", async () => {
    const inner = fakeInner();
    const events = [villageRegistered(), { ...villageRegistered(), name: "village.severity-updated.v1" }];

    await new OwnershipRecordingPublisher(inner, fakeOwnership()).publish(events);

    expect(inner.publish).toHaveBeenCalledWith(events);
  });

  it("records ownership BEFORE delegating, so the row exists before the response is written", async () => {
    const order: string[] = [];
    const ownership = {
      record: vi.fn(async () => {
        order.push("record");
      }),
      isOwner: vi.fn(async () => false),
    };
    const inner = {
      publish: vi.fn(async () => {
        order.push("publish");
      }),
    };

    await new OwnershipRecordingPublisher(inner, ownership).publish([villageRegistered()]);

    expect(order).toEqual(["record", "publish"]);
  });

  it("maps each creation event to its own record type and id field", async () => {
    const ownership = fakeOwnership();
    const events: DomainEvent[] = [
      { ...villageRegistered(), name: "issue.reported.v1", payload: { issueId: "issue-9" } },
      { ...villageRegistered(), name: "volunteer.registered.v1", payload: { volunteerId: "vol-9" } },
      { ...villageRegistered(), name: "plan.created.v1", payload: { planId: "plan-9" } },
      { ...villageRegistered(), name: "signal.detected.v1", payload: { signalId: "sig-9" } },
    ];

    await new OwnershipRecordingPublisher(fakeInner(), ownership).publish(events);

    expect(ownership.record.mock.calls.map((call) => call[0])).toEqual([
      { recordType: "issue", recordId: "issue-9", ownerId: "user-alice" },
      { recordType: "volunteer", recordId: "vol-9", ownerId: "user-alice" },
      { recordType: "plan", recordId: "plan-9", ownerId: "user-alice" },
      { recordType: "signal", recordId: "sig-9", ownerId: "user-alice" },
    ]);
  });

  it("records nothing for events that do not create an ownable record", async () => {
    const ownership = fakeOwnership();

    await new OwnershipRecordingPublisher(fakeInner(), ownership).publish([
      { ...villageRegistered(), name: "village.damage-assessed.v1" },
      { ...villageRegistered(), name: "beneficiary.registered.v1", payload: { beneficiaryId: "b-1" } },
      { ...villageRegistered(), name: "project.sanctioned.v1", payload: { projectId: "p-1" } },
    ]);

    expect(ownership.record).not.toHaveBeenCalled();
  });

  it.each([
    ["system", systemActor("platform")],
    ["anonymous", anonymousActor("legacy-token")],
  ])("invents no owner for a %s actor", async (_label, actor) => {
    const ownership = fakeOwnership();

    await new OwnershipRecordingPublisher(fakeInner(), ownership).publish([villageRegistered({ actor })]);

    expect(ownership.record).not.toHaveBeenCalled();
  });

  it("records nothing for an unstamped event", async () => {
    const ownership = fakeOwnership();
    const { actor: _dropped, ...unstamped } = villageRegistered();

    await new OwnershipRecordingPublisher(fakeInner(), ownership).publish([unstamped as DomainEvent]);

    expect(ownership.record).not.toHaveBeenCalled();
  });

  it("skips a creation event whose id field is missing or not a string", async () => {
    const ownership = fakeOwnership();

    await new OwnershipRecordingPublisher(fakeInner(), ownership).publish([
      villageRegistered({ payload: { name: "no id here" } }),
      villageRegistered({ payload: { villageId: 42 } }),
      villageRegistered({ payload: { villageId: "" } }),
    ]);

    expect(ownership.record).not.toHaveBeenCalled();
  });

  it("does nothing at all for an empty batch", async () => {
    const ownership = fakeOwnership();
    const inner = fakeInner();

    await new OwnershipRecordingPublisher(inner, ownership).publish([]);

    expect(ownership.record).not.toHaveBeenCalled();
    expect(inner.publish).not.toHaveBeenCalled();
  });

  /**
   * The wiring guard. This decorator reads `event.actor`, which only exists once
   * `ActorStampingPublisher` has stamped it — so the two must be nested
   * stamping-outside, recording-inside. Nested the other way it records nothing
   * and every test above still passes, because they all hand it pre-stamped
   * events. This is the one that fails.
   */
  it("records ownership when nested inside the actor stamp, as production wires it", async () => {
    const ownership = fakeOwnership();
    const inner = fakeInner();
    const { actor: _unstamped, ...raw } = villageRegistered();

    const publisher = new ActorStampingPublisher(
      new OwnershipRecordingPublisher(inner, ownership),
      ALICE,
      "req-1",
    );
    await publisher.publish([raw as DomainEvent]);

    expect(ownership.record).toHaveBeenCalledWith({
      recordType: "village",
      recordId: "village-abc",
      ownerId: "user-alice",
    });
  });

  it("records nothing when nested the wrong way round — the failure this ordering prevents", async () => {
    const ownership = fakeOwnership();
    const inner = fakeInner();
    const { actor: _unstamped, ...raw } = villageRegistered();

    // Recording OUTSIDE the stamp: it sees the event before an actor is on it.
    const publisher = new OwnershipRecordingPublisher(
      new ActorStampingPublisher(inner, ALICE, "req-1"),
      ownership,
    );
    await publisher.publish([raw as DomainEvent]);

    expect(ownership.record).not.toHaveBeenCalled();
  });

  it("maps exactly the five ownable record types", () => {
    const mapped = Object.values(OWNERSHIP_EVENT_MAP).map((entry) => entry.recordType);
    expect([...mapped].sort()).toEqual(["issue", "plan", "signal", "village", "volunteer"]);
  });
});
