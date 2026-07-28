import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CapturingEventPublisher,
  FixedClock,
  SequentialIdGenerator,
  isErr,
  isOk,
  unwrap,
} from "@afrip/shared-kernel";
import { RegisterNgo } from "../src/application/register-ngo.js";
import type { NgoRepository } from "../src/application/ports.js";

describe("RegisterNgo use case", () => {
  let ngoRepository: NgoRepository;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;
  let eventPublisher: CapturingEventPublisher;
  let useCase: RegisterNgo;

  beforeEach(() => {
    ngoRepository = {
      findById: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    idGenerator = new SequentialIdGenerator("ngo");
    eventPublisher = new CapturingEventPublisher();
    useCase = new RegisterNgo({ ngoRepository, clock, idGenerator, eventPublisher });
  });

  it("registers a new NGO, saves it via the repository and publishes ngo.registered.v1", async () => {
    const result = await useCase.execute({
      name: "Helping Hands",
      focusAreas: ["shelter", "water"],
      capacity: 3,
    });

    expect(isOk(result)).toBe(true);
    expect(unwrap(result).ngoId).toBe("ngo-1");

    expect(ngoRepository.save).toHaveBeenCalledTimes(1);
    const saved = (ngoRepository.save as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(saved.id).toBe("ngo-1");
    expect(saved.name).toBe("Helping Hands");
    expect(saved.focusAreas).toEqual(["shelter", "water"]);
    expect(saved.capacity).toBe(3);

    expect(eventPublisher.eventNames()).toEqual(["ngo.registered.v1"]);
    const published = eventPublisher.published[0]!;
    expect(published.payload).toEqual({
      ngoId: "ngo-1",
      name: "Helping Hands",
      focusAreas: ["shelter", "water"],
      capacity: 3,
    });
    expect(published.occurredAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("assigns sequential ids across multiple registrations", async () => {
    await useCase.execute({ name: "NGO One", focusAreas: [], capacity: 1 });
    const second = unwrap(await useCase.execute({ name: "NGO Two", focusAreas: [], capacity: 1 }));

    expect(second.ngoId).toBe("ngo-2");
  });

  it("returns err for a blank name without saving or publishing anything", async () => {
    const result = await useCase.execute({ name: "   ", focusAreas: [], capacity: 2 });

    expect(isErr(result)).toBe(true);
    expect(ngoRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("returns err for an invalid capacity without saving or publishing anything", async () => {
    const result = await useCase.execute({ name: "Helping Hands", focusAreas: [], capacity: 0 });

    expect(isErr(result)).toBe(true);
    expect(ngoRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });
});
