import { describe, expect, it } from "vitest";
import {
  ActorStampingPublisher,
  anonymousActor,
  CapturingEventPublisher,
  systemActor,
  userActor,
  type DomainEvent,
} from "../src/index.js";

function event(name: string): DomainEvent {
  return { name, occurredAt: "2026-07-01T00:00:00.000Z", payload: { villageId: "village-1" } };
}

const OFFICER = userActor({
  id: "user-7f3c",
  email: "officer@example.gov.in",
  role: "district_officer",
});

describe("ActorStampingPublisher", () => {
  it("stamps the actor and request id onto every event it forwards", async () => {
    const inner = new CapturingEventPublisher();

    await new ActorStampingPublisher(inner, OFFICER, "req-1").publish([
      event("village.registered.v1"),
      event("village.damage-assessed.v1"),
    ]);

    expect(inner.published.map((e) => [e.name, e.actor, e.requestId])).toEqual([
      ["village.registered.v1", OFFICER, "req-1"],
      ["village.damage-assessed.v1", OFFICER, "req-1"],
    ]);
  });

  it("leaves the payload and the rest of the event untouched", async () => {
    const inner = new CapturingEventPublisher();
    const original = event("village.registered.v1");

    await new ActorStampingPublisher(inner, OFFICER, "req-1").publish([original]);

    expect(inner.published[0]?.payload).toEqual(original.payload);
    expect(inner.published[0]?.occurredAt).toBe(original.occurredAt);
    // The use case's own event object is not mutated: it published a plain
    // event and is entitled to still hold one.
    expect(original.actor).toBeUndefined();
  });

  it("omits requestId for work that belongs to no request", async () => {
    const inner = new CapturingEventPublisher();

    await new ActorStampingPublisher(inner, systemActor("anomaly-sweep")).publish([
      event("project.anomaly-flagged.v1"),
    ]);

    expect(inner.published[0]?.actor).toEqual({ kind: "system", name: "anomaly-sweep" });
    expect(inner.published[0]?.requestId).toBeUndefined();
  });

  /**
   * Attribution belongs to the composition path that is publishing, not to
   * whatever the event arrived carrying. Otherwise a stamp applied upstream —
   * or forged into an event by a caller — would survive the boundary that is
   * supposed to be authoritative about who acted.
   */
  it("overrides an actor the event already carried", async () => {
    const inner = new CapturingEventPublisher();
    const preStamped: DomainEvent = { ...event("village.registered.v1"), actor: OFFICER };

    await new ActorStampingPublisher(inner, anonymousActor("legacy-token")).publish([preStamped]);

    expect(inner.published[0]?.actor).toEqual({ kind: "anonymous", via: "legacy-token" });
  });

  it("does not call the inner publisher for an empty batch", async () => {
    let calls = 0;
    const inner = { publish: async () => void (calls += 1) };

    await new ActorStampingPublisher(inner, OFFICER).publish([]);

    expect(calls).toBe(0);
  });
});
