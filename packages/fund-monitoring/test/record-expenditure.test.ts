import { describe, expect, it } from "vitest";
import { isErr, unwrap } from "@afrip/shared-kernel";
import { RecordExpenditure } from "../src/application/record-expenditure.js";
import { clockMock, makeProject, money, NOW, publisherMock, repositoryMock } from "./helpers.js";

function inProgressProject(releasedMinor = 500) {
  const project = makeProject({ sanctionedMinor: 1_000 });
  project.release(money(releasedMinor), NOW);
  return project;
}

function setup(project = inProgressProject()) {
  const repository = repositoryMock(project);
  const eventPublisher = publisherMock();
  const clock = clockMock();
  const useCase = new RecordExpenditure({ repository, eventPublisher, clock });
  return { repository, eventPublisher, clock, useCase, project };
}

describe("RecordExpenditure use case", () => {
  it("appends the expenditure, saves, and returns the running total", async () => {
    const { repository, useCase, project } = setup();

    const result = await useCase.execute({
      projectId: "proj-1",
      amountMinor: 200,
      description: "cement",
      evidenceRef: "receipt-9",
    });

    expect(unwrap(result)).toEqual({ projectId: "proj-1", totalSpentMinor: 200 });
    expect(repository.findById).toHaveBeenCalledWith("proj-1");
    expect(repository.save).toHaveBeenCalledWith(project);
    expect(project.expenditures).toHaveLength(1);
    expect(project.expenditures[0]).toMatchObject({
      description: "cement",
      evidenceRef: "receipt-9",
      spentAt: NOW.toISOString(),
    });
  });

  it("publishes project.expenditure-recorded.v1", async () => {
    const { eventPublisher, useCase } = setup();

    await useCase.execute({ projectId: "proj-1", amountMinor: 200, description: "cement" });

    expect(eventPublisher.publish).toHaveBeenCalledWith([
      {
        name: "project.expenditure-recorded.v1",
        occurredAt: NOW.toISOString(),
        payload: {
          projectId: "proj-1",
          amountMinor: 200,
          description: "cement",
          totalSpentMinor: 200,
          evidenceRef: null,
        },
      },
    ]);
  });

  it("returns err when the project is still 'sanctioned'", async () => {
    const { repository, eventPublisher, useCase } = setup(makeProject());

    const result = await useCase.execute({ projectId: "proj-1", amountMinor: 10, description: "x" });

    expect(isErr(result)).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });

  it("returns err when the project is completed", async () => {
    const project = inProgressProject();
    project.complete();
    const { useCase, repository } = setup(project);

    const result = await useCase.execute({ projectId: "proj-1", amountMinor: 10, description: "x" });

    expect(isErr(result)).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("allows spending exactly up to released", async () => {
    const { useCase } = setup(inProgressProject(500));
    const result = await useCase.execute({ projectId: "proj-1", amountMinor: 500, description: "all" });
    expect(unwrap(result).totalSpentMinor).toBe(500);
  });

  it("rejects one paisa over released without saving or publishing", async () => {
    const { repository, eventPublisher, useCase, project } = setup(inProgressProject(500));

    const result = await useCase.execute({ projectId: "proj-1", amountMinor: 501, description: "over" });

    expect(isErr(result)).toBe(true);
    expect(project.spent.amountMinor).toBe(0);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });

  it("returns err when the project does not exist", async () => {
    const repository = repositoryMock(null);
    const useCase = new RecordExpenditure({
      repository,
      eventPublisher: publisherMock(),
      clock: clockMock(),
    });

    const result = await useCase.execute({ projectId: "ghost", amountMinor: 1, description: "x" });

    expect(isErr(result)).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it.each([
    ["zero amount", { amountMinor: 0, description: "x" }],
    ["negative amount", { amountMinor: -1, description: "x" }],
    ["non-integer amount", { amountMinor: 1.5, description: "x" }],
    ["empty description", { amountMinor: 10, description: "  " }],
  ])("returns err for %s", async (_label, partial) => {
    const { repository, useCase } = setup();
    const result = await useCase.execute({ projectId: "proj-1", ...partial });
    expect(isErr(result)).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
  });
});
