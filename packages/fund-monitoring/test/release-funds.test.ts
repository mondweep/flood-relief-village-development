import { describe, expect, it } from "vitest";
import { isErr, unwrap } from "@afrip/shared-kernel";
import { ReleaseFunds } from "../src/application/release-funds.js";
import { clockMock, makeProject, money, NOW, publisherMock, repositoryMock } from "./helpers.js";

function setup(project = makeProject({ sanctionedMinor: 1_000 })) {
  const repository = repositoryMock(project);
  const eventPublisher = publisherMock();
  const clock = clockMock();
  const useCase = new ReleaseFunds({ repository, eventPublisher, clock });
  return { repository, eventPublisher, clock, useCase, project };
}

describe("ReleaseFunds use case", () => {
  it("looks up the project, saves the release, and moves status to in_progress", async () => {
    const { repository, useCase, project } = setup();

    const result = await useCase.execute({ projectId: "proj-1", amountMinor: 400 });

    expect(unwrap(result)).toEqual({ projectId: "proj-1", totalReleasedMinor: 400, status: "in_progress" });
    expect(repository.findById).toHaveBeenCalledWith("proj-1");
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith(project);
    expect(project.released.amountMinor).toBe(400);
    expect(project.status).toBe("in_progress");
    expect(project.lastReleasedAt).toBe(NOW.toISOString());
  });

  it("publishes project.funds-released.v1", async () => {
    const { eventPublisher, useCase } = setup();

    await useCase.execute({ projectId: "proj-1", amountMinor: 400 });

    expect(eventPublisher.publish).toHaveBeenCalledWith([
      {
        name: "project.funds-released.v1",
        occurredAt: NOW.toISOString(),
        payload: { projectId: "proj-1", amountMinor: 400, totalReleasedMinor: 400, status: "in_progress" },
      },
    ]);
  });

  it("keeps status 'in_progress' on subsequent releases", async () => {
    const project = makeProject({ sanctionedMinor: 1_000 });
    project.release(money(300), NOW);
    const { useCase } = setup(project);

    const result = await useCase.execute({ projectId: "proj-1", amountMinor: 200 });

    expect(unwrap(result).totalReleasedMinor).toBe(500);
    expect(project.status).toBe("in_progress");
  });

  it("allows releasing exactly up to the sanctioned amount", async () => {
    const { useCase } = setup();
    const result = await useCase.execute({ projectId: "proj-1", amountMinor: 1_000 });
    expect(unwrap(result).totalReleasedMinor).toBe(1_000);
  });

  it("rejects one paisa over sanctioned without saving or publishing", async () => {
    const { repository, eventPublisher, useCase, project } = setup();

    const result = await useCase.execute({ projectId: "proj-1", amountMinor: 1_001 });

    expect(isErr(result)).toBe(true);
    expect(project.released.amountMinor).toBe(0);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });

  it("returns err when the project does not exist", async () => {
    const repository = repositoryMock(null);
    const useCase = new ReleaseFunds({ repository, eventPublisher: publisherMock(), clock: clockMock() });

    const result = await useCase.execute({ projectId: "ghost", amountMinor: 100 });

    expect(isErr(result)).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["non-integer", 10.5],
  ])("returns err for a %s amount", async (_label, amountMinor) => {
    const { repository, eventPublisher, useCase } = setup();
    const result = await useCase.execute({ projectId: "proj-1", amountMinor });
    expect(isErr(result)).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });
});
