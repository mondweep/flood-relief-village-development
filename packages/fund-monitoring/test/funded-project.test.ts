import { describe, expect, it } from "vitest";
import { Money, projectId, unwrap, villageId } from "@afrip/shared-kernel";
import { FundedProject } from "../src/domain/funded-project.js";

const PID = unwrap(projectId("project-1"));
const VID = unwrap(villageId("village-1"));

function money(amountMinor: number): Money {
  return unwrap(Money.of(amountMinor));
}

function sanctionedProject(sanctionedMinor = 100_000): FundedProject {
  return unwrap(
    FundedProject.sanction({
      id: PID,
      villageId: VID,
      name: "Village bridge rebuild",
      category: "bridge",
      fundSource: "district",
      sanctioned: money(sanctionedMinor),
    }),
  );
}

function inProgressProject(sanctionedMinor = 100_000, releasedMinor = 60_000): FundedProject {
  const project = sanctionedProject(sanctionedMinor);
  const released = project.release(money(releasedMinor), "2026-01-10T00:00:00.000Z");
  expect(released.ok).toBe(true);
  return project;
}

describe("FundedProject.sanction", () => {
  it("creates a project in 'sanctioned' status with zero released and spent", () => {
    const project = sanctionedProject(250_000);

    expect(project.id).toBe("project-1");
    expect(project.villageId).toBe("village-1");
    expect(project.name).toBe("Village bridge rebuild");
    expect(project.category).toBe("bridge");
    expect(project.fundSource).toBe("district");
    expect(project.status).toBe("sanctioned");
    expect(project.sanctioned.amountMinor).toBe(250_000);
    expect(project.released.amountMinor).toBe(0);
    expect(project.spent.amountMinor).toBe(0);
    expect(project.expenditures).toHaveLength(0);
    expect(project.anomalies).toHaveLength(0);
  });

  it("rejects an empty name", () => {
    const result = FundedProject.sanction({
      id: PID,
      villageId: VID,
      name: "   ",
      category: "bridge",
      fundSource: "district",
      sanctioned: money(100),
    });

    expect(result.ok).toBe(false);
  });
});

describe("FundedProject.release (released <= sanctioned)", () => {
  it("allows releasing exactly up to the sanctioned amount", () => {
    const project = sanctionedProject(100_000);

    const result = project.release(money(100_000), "2026-01-10T00:00:00.000Z");

    expect(result.ok).toBe(true);
    expect(project.released.amountMinor).toBe(100_000);
  });

  it("rejects a release one paisa over the sanctioned amount", () => {
    const project = sanctionedProject(100_000);

    const result = project.release(money(100_001), "2026-01-10T00:00:00.000Z");

    expect(result.ok).toBe(false);
    expect(project.released.amountMinor).toBe(0);
    expect(project.status).toBe("sanctioned");
  });

  it("rejects a cumulative release one paisa over the sanctioned amount", () => {
    const project = sanctionedProject(100_000);
    expect(project.release(money(60_000), "2026-01-10T00:00:00.000Z").ok).toBe(true);

    const result = project.release(money(40_001), "2026-01-11T00:00:00.000Z");

    expect(result.ok).toBe(false);
    expect(project.released.amountMinor).toBe(60_000);
  });

  it("allows a cumulative release exactly up to the sanctioned amount", () => {
    const project = sanctionedProject(100_000);
    expect(project.release(money(60_000), "2026-01-10T00:00:00.000Z").ok).toBe(true);

    const result = project.release(money(40_000), "2026-01-11T00:00:00.000Z");

    expect(result.ok).toBe(true);
    expect(project.released.amountMinor).toBe(100_000);
  });

  it("moves status to 'in_progress' on the first release only", () => {
    const project = sanctionedProject(100_000);

    const first = project.release(money(10_000), "2026-01-10T00:00:00.000Z");
    expect(first.ok && first.value.firstRelease).toBe(true);
    expect(project.status).toBe("in_progress");

    const second = project.release(money(10_000), "2026-01-11T00:00:00.000Z");
    expect(second.ok && !second.value.firstRelease).toBe(true);
    expect(project.status).toBe("in_progress");
  });

  it("rejects releases once the project is completed or verified", () => {
    const project = inProgressProject();
    expect(project.complete().ok).toBe(true);
    expect(project.release(money(1), "2026-03-01T00:00:00.000Z").ok).toBe(false);

    expect(project.verify().ok).toBe(true);
    expect(project.release(money(1), "2026-03-02T00:00:00.000Z").ok).toBe(false);
  });

  it("rejects a zero-amount release", () => {
    const project = sanctionedProject(100_000);

    const result = project.release(money(0), "2026-01-10T00:00:00.000Z");

    expect(result.ok).toBe(false);
    expect(project.status).toBe("sanctioned");
  });

  it("rejects a release in a different currency", () => {
    const project = sanctionedProject(100_000);

    const result = project.release(unwrap(Money.of(10, "USD")), "2026-01-10T00:00:00.000Z");

    expect(result.ok).toBe(false);
  });
});

describe("FundedProject.recordExpenditure (spent <= released, only while in_progress)", () => {
  it("rejects expenditure while still 'sanctioned'", () => {
    const project = sanctionedProject(100_000);

    const result = project.recordExpenditure(money(1), "cement", "2026-01-15T00:00:00.000Z");

    expect(result.ok).toBe(false);
  });

  it("allows spending exactly up to the released amount", () => {
    const project = inProgressProject(100_000, 60_000);

    const result = project.recordExpenditure(money(60_000), "cement", "2026-01-15T00:00:00.000Z");

    expect(result.ok).toBe(true);
    expect(project.spent.amountMinor).toBe(60_000);
  });

  it("rejects spending one paisa over the released amount", () => {
    const project = inProgressProject(100_000, 60_000);

    const result = project.recordExpenditure(money(60_001), "cement", "2026-01-15T00:00:00.000Z");

    expect(result.ok).toBe(false);
    expect(project.spent.amountMinor).toBe(0);
    expect(project.expenditures).toHaveLength(0);
  });

  it("rejects a cumulative spend one paisa over the released amount", () => {
    const project = inProgressProject(100_000, 60_000);
    expect(project.recordExpenditure(money(40_000), "cement", "2026-01-15T00:00:00.000Z").ok).toBe(true);

    const result = project.recordExpenditure(money(20_001), "labour", "2026-01-16T00:00:00.000Z");

    expect(result.ok).toBe(false);
    expect(project.spent.amountMinor).toBe(40_000);
    expect(project.expenditures).toHaveLength(1);
  });

  it("appends expenditures with description, spentAt and optional evidenceRef", () => {
    const project = inProgressProject(100_000, 60_000);

    expect(
      project.recordExpenditure(money(10_000), "cement", "2026-01-15T00:00:00.000Z", "photo-1").ok,
    ).toBe(true);
    expect(project.recordExpenditure(money(5_000), "labour", "2026-01-16T00:00:00.000Z").ok).toBe(true);

    expect(project.expenditures).toHaveLength(2);
    expect(project.expenditures[0]?.amount.amountMinor).toBe(10_000);
    expect(project.expenditures[0]?.description).toBe("cement");
    expect(project.expenditures[0]?.spentAt).toBe("2026-01-15T00:00:00.000Z");
    expect(project.expenditures[0]?.evidenceRef).toBe("photo-1");
    expect(project.expenditures[1]?.evidenceRef).toBeUndefined();
    expect(project.spent.amountMinor).toBe(15_000);
  });

  it("rejects a zero-amount expenditure", () => {
    const project = inProgressProject();

    const result = project.recordExpenditure(money(0), "nothing", "2026-01-15T00:00:00.000Z");

    expect(result.ok).toBe(false);
  });

  it("rejects an empty description", () => {
    const project = inProgressProject();

    const result = project.recordExpenditure(money(1), "  ", "2026-01-15T00:00:00.000Z");

    expect(result.ok).toBe(false);
  });

  it("rejects expenditure once completed or verified", () => {
    const project = inProgressProject();
    expect(project.complete().ok).toBe(true);
    expect(project.recordExpenditure(money(1), "late", "2026-03-01T00:00:00.000Z").ok).toBe(false);

    expect(project.verify().ok).toBe(true);
    expect(project.recordExpenditure(money(1), "late", "2026-03-02T00:00:00.000Z").ok).toBe(false);
  });
});

describe("FundedProject status transitions (forward only)", () => {
  it("cannot complete a project that has never had funds released", () => {
    const project = sanctionedProject();

    expect(project.complete().ok).toBe(false);
    expect(project.status).toBe("sanctioned");
  });

  it("completes only from 'in_progress' and only once", () => {
    const project = inProgressProject();

    expect(project.complete().ok).toBe(true);
    expect(project.status).toBe("completed");
    expect(project.complete().ok).toBe(false);
  });

  it("cannot verify unless completed", () => {
    const sanctioned = sanctionedProject();
    expect(sanctioned.verify().ok).toBe(false);

    const inProgress = inProgressProject();
    expect(inProgress.verify().ok).toBe(false);
  });

  it("verifies only from 'completed' and only once", () => {
    const project = inProgressProject();
    expect(project.complete().ok).toBe(true);

    expect(project.verify().ok).toBe(true);
    expect(project.status).toBe("verified");
    expect(project.verify().ok).toBe(false);
  });
});
