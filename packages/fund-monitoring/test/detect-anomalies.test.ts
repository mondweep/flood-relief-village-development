import { describe, expect, it } from "vitest";
import { isErr, unwrap } from "@afrip/shared-kernel";
import { DetectAnomalies } from "../src/application/detect-anomalies.js";
import { clockMock, makeProject, money, publisherMock, repositoryMock } from "./helpers.js";
import type { FundedProject } from "../src/domain/funded-project.js";

const RELEASED_AT = new Date("2026-01-01T00:00:00.000Z");

function spender(spentMinor: number): FundedProject {
  const project = makeProject({ sanctionedMinor: 1_000_000, category: "school" });
  project.release(money(1_000_000), RELEASED_AT);
  if (spentMinor > 0) {
    project.recordExpenditure(money(spentMinor), "works", "2026-01-02T00:00:00.000Z");
  }
  return project;
}

describe("DetectAnomalies use case", () => {
  it("appends findings to the project, saves it, and publishes one event per finding", async () => {
    // Heavy spend, then a later release with no expenditure afterwards -> stalled also fires.
    const project = makeProject({ sanctionedMinor: 1_000_000, category: "school" });
    project.release(money(900_000), RELEASED_AT);
    project.recordExpenditure(money(900_000), "works", "2026-01-02T00:00:00.000Z");
    project.release(money(100_000), new Date("2026-02-01T00:00:00.000Z"));
    const repository = repositoryMock(project);
    const eventPublisher = publisherMock();
    const now = new Date("2026-06-01T00:00:00.000Z");
    const useCase = new DetectAnomalies({ repository, eventPublisher, clock: clockMock(now) });

    const result = await useCase.execute({
      projectId: "proj-1",
      comparableSpentMinor: [100, 200, 300],
      stalledAfterDays: 60,
      otherActiveProjects: [{ villageId: "vil-1", category: "school" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projectId).toBe("proj-1");
    expect(result.value.findings.map((f) => f.type).sort()).toEqual([
      "duplicate_funding",
      "overspend_vs_comparable",
      "stalled",
    ]);

    expect(repository.findById).toHaveBeenCalledWith("proj-1");
    expect(repository.save).toHaveBeenCalledWith(project);
    expect(project.anomalies).toHaveLength(3);

    expect(eventPublisher.publish).toHaveBeenCalledTimes(1);
    const events = eventPublisher.publish.mock.calls[0]![0]!;
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.name).toBe("project.anomaly-flagged.v1");
      expect(event.occurredAt).toBe("2026-06-01T00:00:00.000Z");
      expect(event.payload.projectId).toBe("proj-1");
      expect(event.payload.villageId).toBe("vil-1");
      expect(event.payload.detectedAt).toBe("2026-06-01T00:00:00.000Z");
      expect(typeof event.payload.details).toBe("string");
    }
    expect(events.map((e: { payload: { type: string } }) => e.payload.type).sort()).toEqual([
      "duplicate_funding",
      "overspend_vs_comparable",
      "stalled",
    ]);
  });

  it("defaults stalledAfterDays to 60", async () => {
    const project = spender(0);
    const repository = repositoryMock(project);
    const eventPublisher = publisherMock();

    // 61 days after the release, no expenditure ever recorded
    const useCase = new DetectAnomalies({
      repository,
      eventPublisher,
      clock: clockMock(new Date("2026-03-03T00:00:00.000Z")),
    });

    const result = await useCase.execute({ projectId: "proj-1" });

    expect(unwrap(result).findings.map((f) => f.type)).toEqual(["stalled"]);
  });

  it("does not save or publish when no anomalies are found", async () => {
    const project = spender(100);
    const repository = repositoryMock(project);
    const eventPublisher = publisherMock();
    const useCase = new DetectAnomalies({
      repository,
      eventPublisher,
      clock: clockMock(new Date("2026-01-03T00:00:00.000Z")),
    });

    const result = await useCase.execute({
      projectId: "proj-1",
      comparableSpentMinor: [100, 100, 100],
    });

    expect(unwrap(result).findings).toEqual([]);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });

  it("skips the overspend rule when fewer than 3 comparables are provided", async () => {
    const project = spender(1_000_000);
    const repository = repositoryMock(project);
    const eventPublisher = publisherMock();
    const useCase = new DetectAnomalies({
      repository,
      eventPublisher,
      clock: clockMock(new Date("2026-01-03T00:00:00.000Z")),
    });

    const result = await useCase.execute({
      projectId: "proj-1",
      comparableSpentMinor: [1, 2],
    });

    expect(unwrap(result).findings).toEqual([]);
  });

  it("adds no anomalies and publishes no events on a repeat run over an unchanged project", async () => {
    const project = spender(0); // released, never spent -> stalled
    const repository = repositoryMock(project);
    const eventPublisher = publisherMock();
    const useCase = new DetectAnomalies({
      repository,
      eventPublisher,
      clock: clockMock(new Date("2026-06-01T00:00:00.000Z")),
    });

    const first = await useCase.execute({ projectId: "proj-1", stalledAfterDays: 60 });
    expect(unwrap(first).findings.map((f) => f.type)).toEqual(["stalled"]);
    expect(project.anomalies).toHaveLength(1);
    expect(eventPublisher.publish).toHaveBeenCalledTimes(1);

    const second = await useCase.execute({ projectId: "proj-1", stalledAfterDays: 60 });
    expect(unwrap(second).findings).toEqual([]);
    expect(project.anomalies).toHaveLength(1);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(eventPublisher.publish).toHaveBeenCalledTimes(1);
  });

  it("returns err when the project does not exist", async () => {
    const repository = repositoryMock(null);
    const useCase = new DetectAnomalies({
      repository,
      eventPublisher: publisherMock(),
      clock: clockMock(),
    });

    const result = await useCase.execute({ projectId: "ghost" });

    expect(isErr(result)).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("returns err for an invalid stalledAfterDays", async () => {
    const repository = repositoryMock(spender(0));
    const useCase = new DetectAnomalies({
      repository,
      eventPublisher: publisherMock(),
      clock: clockMock(),
    });

    const result = await useCase.execute({ projectId: "proj-1", stalledAfterDays: 0 });

    expect(isErr(result)).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
  });
});
