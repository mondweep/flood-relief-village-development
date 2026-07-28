import { describe, expect, it } from "vitest";
import { isErr, unwrap } from "@afrip/shared-kernel";
import { CompleteProject } from "../src/application/complete-project.js";
import { VerifyProject } from "../src/application/verify-project.js";
import { clockMock, makeProject, money, NOW, publisherMock, repositoryMock } from "./helpers.js";
import type { FundedProject } from "../src/domain/funded-project.js";

function inProgressProject(): FundedProject {
  const project = makeProject({ sanctionedMinor: 1_000 });
  project.release(money(500), NOW);
  return project;
}

function completedProject(): FundedProject {
  const project = inProgressProject();
  project.complete();
  return project;
}

describe("CompleteProject use case", () => {
  it("moves an in_progress project to 'completed', saves it, and publishes project.completed.v1", async () => {
    const project = inProgressProject();
    const repository = repositoryMock(project);
    const eventPublisher = publisherMock();
    const useCase = new CompleteProject({ repository, eventPublisher, clock: clockMock() });

    const result = await useCase.execute({ projectId: "proj-1" });

    expect(unwrap(result)).toEqual({ projectId: "proj-1", status: "completed" });
    expect(repository.findById).toHaveBeenCalledWith("proj-1");
    expect(repository.save).toHaveBeenCalledWith(project);
    expect(project.status).toBe("completed");
    expect(eventPublisher.publish).toHaveBeenCalledWith([
      {
        name: "project.completed.v1",
        occurredAt: NOW.toISOString(),
        payload: { projectId: "proj-1" },
      },
    ]);
  });

  it("returns err for a project that is still 'sanctioned'", async () => {
    const repository = repositoryMock(makeProject());
    const eventPublisher = publisherMock();
    const useCase = new CompleteProject({ repository, eventPublisher, clock: clockMock() });

    const result = await useCase.execute({ projectId: "proj-1" });

    expect(isErr(result)).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });

  it("returns err for an already-completed project", async () => {
    const repository = repositoryMock(completedProject());
    const useCase = new CompleteProject({
      repository,
      eventPublisher: publisherMock(),
      clock: clockMock(),
    });

    expect(isErr(await useCase.execute({ projectId: "proj-1" }))).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("returns err when the project does not exist", async () => {
    const repository = repositoryMock(null);
    const useCase = new CompleteProject({
      repository,
      eventPublisher: publisherMock(),
      clock: clockMock(),
    });

    expect(isErr(await useCase.execute({ projectId: "ghost" }))).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
  });
});

describe("VerifyProject use case", () => {
  it("moves a completed project to 'verified', saves it, and publishes project.verified.v1", async () => {
    const project = completedProject();
    const repository = repositoryMock(project);
    const eventPublisher = publisherMock();
    const useCase = new VerifyProject({ repository, eventPublisher, clock: clockMock() });

    const result = await useCase.execute({ projectId: "proj-1" });

    expect(unwrap(result)).toEqual({ projectId: "proj-1", status: "verified" });
    expect(repository.save).toHaveBeenCalledWith(project);
    expect(project.status).toBe("verified");
    expect(eventPublisher.publish).toHaveBeenCalledWith([
      {
        name: "project.verified.v1",
        occurredAt: NOW.toISOString(),
        payload: { projectId: "proj-1" },
      },
    ]);
  });

  it.each([
    ["sanctioned", () => makeProject()],
    ["in_progress", inProgressProject],
  ])("returns err when the project is %s", async (_label, build) => {
    const repository = repositoryMock(build());
    const eventPublisher = publisherMock();
    const useCase = new VerifyProject({ repository, eventPublisher, clock: clockMock() });

    const result = await useCase.execute({ projectId: "proj-1" });

    expect(isErr(result)).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });

  it("returns err when the project does not exist", async () => {
    const repository = repositoryMock(null);
    const useCase = new VerifyProject({
      repository,
      eventPublisher: publisherMock(),
      clock: clockMock(),
    });

    expect(isErr(await useCase.execute({ projectId: "ghost" }))).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
  });
});
