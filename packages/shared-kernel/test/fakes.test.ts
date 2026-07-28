import { describe, it, expect } from "vitest";
import {
  FixedClock,
  SequentialIdGenerator,
  CapturingEventPublisher,
  InMemoryEventBus,
} from "../src/fakes.js";
import type { DomainEvent } from "../src/events.js";

describe("test fakes", () => {
  it("FixedClock returns the configured instant until advanced", () => {
    const clock = new FixedClock(new Date("2026-07-01T00:00:00Z"));
    expect(clock.now().toISOString()).toBe("2026-07-01T00:00:00.000Z");
    clock.advanceDays(10);
    expect(clock.now().toISOString()).toBe("2026-07-11T00:00:00.000Z");
  });

  it("SequentialIdGenerator yields prefixed incrementing ids", () => {
    const gen = new SequentialIdGenerator("vil");
    expect(gen.next()).toBe("vil-1");
    expect(gen.next()).toBe("vil-2");
  });

  it("CapturingEventPublisher records everything published", async () => {
    const pub = new CapturingEventPublisher();
    const event: DomainEvent = {
      name: "village.registered.v1",
      occurredAt: "2026-07-01T00:00:00.000Z",
      payload: { villageId: "vil-1" },
    };
    await pub.publish([event]);
    expect(pub.published).toHaveLength(1);
    expect(pub.eventNames()).toEqual(["village.registered.v1"]);
  });

  it("InMemoryEventBus delivers events to subscribers by name", async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe("aid.recorded.v1", async (e) => {
      seen.push(String((e.payload as Record<string, unknown>).beneficiaryId));
    });
    await bus.publish([
      { name: "aid.recorded.v1", occurredAt: "2026-07-01T00:00:00.000Z", payload: { beneficiaryId: "ben-9" } },
      { name: "other.event.v1", occurredAt: "2026-07-01T00:00:00.000Z", payload: {} },
    ]);
    expect(seen).toEqual(["ben-9"]);
  });
});
