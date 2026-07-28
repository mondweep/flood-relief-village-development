import { describe, expect, it } from "vitest";
import { isErr, unwrap } from "@afrip/shared-kernel";
import { SanctionProject } from "../src/application/sanction-project.js";
import { clockMock, idGeneratorMock, NOW, publisherMock, repositoryMock } from "./helpers.js";

function setup() {
  const repository = repositoryMock();
  const eventPublisher = publisherMock();
  const clock = clockMock();
  const idGenerator = idGeneratorMock(["proj-42"]);
  const useCase = new SanctionProject({ repository, eventPublisher, clock, idGenerator });
  return { repository, eventPublisher, clock, idGenerator, useCase };
}

const validInput = {
  villageId: "vil-1",
  name: "Bridge rebuild",
  category: "bridge",
  fundSource: "district",
  sanctionedMinor: 1_000_000,
} as const;

describe("SanctionProject use case", () => {
  it("saves a sanctioned project and returns its id", async () => {
    const { repository, useCase, idGenerator } = setup();

    const result = await useCase.execute({ ...validInput });

    expect(unwrap(result)).toEqual({ projectId: "proj-42" });
    expect(idGenerator.next).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledTimes(1);
    const saved = repository.save.mock.calls[0]![0]!;
    expect(saved.id).toBe("proj-42");
    expect(saved.villageId).toBe("vil-1");
    expect(saved.name).toBe("Bridge rebuild");
    expect(saved.category).toBe("bridge");
    expect(saved.fundSource).toBe("district");
    expect(saved.status).toBe("sanctioned");
    expect(saved.sanctioned.amountMinor).toBe(1_000_000);
    expect(saved.released.amountMinor).toBe(0);
    expect(saved.spent.amountMinor).toBe(0);
  });

  it("publishes project.sanctioned.v1 with the clock instant", async () => {
    const { eventPublisher, useCase } = setup();

    await useCase.execute({ ...validInput });

    expect(eventPublisher.publish).toHaveBeenCalledTimes(1);
    expect(eventPublisher.publish).toHaveBeenCalledWith([
      {
        name: "project.sanctioned.v1",
        occurredAt: NOW.toISOString(),
        payload: { projectId: "proj-42", villageId: "vil-1", sanctionedMinor: 1_000_000 },
      },
    ]);
  });

  it.each([
    ["empty villageId", { ...validInput, villageId: "" }],
    ["empty name", { ...validInput, name: "  " }],
    ["invalid category", { ...validInput, category: "casino" }],
    ["invalid fundSource", { ...validInput, fundSource: "crypto" }],
    ["non-integer amount", { ...validInput, sanctionedMinor: 10.5 }],
    ["negative amount", { ...validInput, sanctionedMinor: -1 }],
    ["zero amount", { ...validInput, sanctionedMinor: 0 }],
  ])("returns err and performs no side effects for %s", async (_label, input) => {
    const { repository, eventPublisher, useCase } = setup();

    const result = await useCase.execute(input as never);

    expect(isErr(result)).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });
});
