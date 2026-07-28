import { describe, expect, it, vi } from "vitest";
import { InMemoryEventBus, ok } from "@afrip/shared-kernel";
import {
  DAMAGE_ASSESSED_EVENT,
  makeDamageAssessedHandler,
} from "../src/application/damage-assessed-handler.js";

describe("makeDamageAssessedHandler", () => {
  it("invokes the recalculation use case when village.damage-assessed.v1 is published", async () => {
    const execute = vi.fn().mockResolvedValue(ok({}));
    const bus = new InMemoryEventBus();
    bus.subscribe(DAMAGE_ASSESSED_EVENT, makeDamageAssessedHandler({ execute }));

    await bus.publish([
      {
        name: "village.damage-assessed.v1",
        occurredAt: "2026-03-01T00:00:00.000Z",
        payload: { villageId: "village-1", assessedAt: "2026-03-01T00:00:00.000Z" },
      },
    ]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ villageId: "village-1", scores: {} });
  });

  it("invokes the use case once per matching event", async () => {
    const execute = vi.fn().mockResolvedValue(ok({}));
    const bus = new InMemoryEventBus();
    bus.subscribe(DAMAGE_ASSESSED_EVENT, makeDamageAssessedHandler({ execute }));

    await bus.publish([
      { name: "village.damage-assessed.v1", occurredAt: "t1", payload: { villageId: "village-1" } },
      { name: "village.damage-assessed.v1", occurredAt: "t2", payload: { villageId: "village-2" } },
    ]);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(2, { villageId: "village-2", scores: {} });
  });

  it("does not invoke the use case for unrelated events", async () => {
    const execute = vi.fn().mockResolvedValue(ok({}));
    const bus = new InMemoryEventBus();
    bus.subscribe(DAMAGE_ASSESSED_EVENT, makeDamageAssessedHandler({ execute }));

    await bus.publish([
      { name: "village.registered.v1", occurredAt: "t", payload: { villageId: "village-1" } },
    ]);

    expect(execute).not.toHaveBeenCalled();
  });

  it("ignores events whose payload has no usable villageId", async () => {
    const execute = vi.fn().mockResolvedValue(ok({}));
    const handler = makeDamageAssessedHandler({ execute });

    await handler({ name: "village.damage-assessed.v1", occurredAt: "t", payload: {} });
    await handler({ name: "village.damage-assessed.v1", occurredAt: "t", payload: { villageId: 42 } });

    expect(execute).not.toHaveBeenCalled();
  });
});
