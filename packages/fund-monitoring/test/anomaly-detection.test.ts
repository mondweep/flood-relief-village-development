import { describe, expect, it } from "vitest";
import { Money, projectId, unwrap, villageId } from "@afrip/shared-kernel";
import { FundedProject, type AnomalyDetectionInput } from "../src/domain/funded-project.js";

const PID = unwrap(projectId("project-1"));
const VID = unwrap(villageId("village-1"));

function money(amountMinor: number): Money {
  return unwrap(Money.of(amountMinor));
}

function detectionInput(overrides: Partial<AnomalyDetectionInput> = {}): AnomalyDetectionInput {
  return {
    comparableSpentMinor: [],
    stalledAfterDays: 60,
    otherActiveProjects: [],
    ...overrides,
  };
}

function projectWithSpend(spentMinor: number): FundedProject {
  const project = unwrap(
    FundedProject.sanction({
      id: PID,
      villageId: VID,
      name: "School repair",
      category: "school",
      fundSource: "csr",
      sanctioned: money(1_000_000),
    }),
  );
  expect(project.release(money(1_000_000), "2026-01-01T00:00:00.000Z").ok).toBe(true);
  if (spentMinor > 0) {
    expect(project.recordExpenditure(money(spentMinor), "works", "2026-01-05T00:00:00.000Z").ok).toBe(
      true,
    );
  }
  return project;
}

describe("anomaly rule: overspend_vs_comparable", () => {
  it("flags when spent exceeds 1.5x the median of comparables", () => {
    const project = projectWithSpend(151);
    const now = new Date("2026-01-06T00:00:00.000Z");

    const findings = project.detectAnomalies(
      detectionInput({ comparableSpentMinor: [90, 100, 110] }),
      now,
    );

    expect(findings.map((f) => f.type)).toEqual(["overspend_vs_comparable"]);
    expect(findings[0]?.detectedAt).toBe("2026-01-06T00:00:00.000Z");
    expect(project.anomalies).toHaveLength(1);
  });

  it("does not flag when spent equals exactly 1.5x the median", () => {
    const project = projectWithSpend(150);

    const findings = project.detectAnomalies(
      detectionInput({ comparableSpentMinor: [90, 100, 110] }),
      new Date("2026-01-06T00:00:00.000Z"),
    );

    expect(findings).toHaveLength(0);
    expect(project.anomalies).toHaveLength(0);
  });

  it("uses the average of the two middle values for an even comparable count", () => {
    // comparables [100, 200, 300, 400] -> median 250 -> threshold 375
    const over = projectWithSpend(376);
    expect(
      over.detectAnomalies(
        detectionInput({ comparableSpentMinor: [400, 100, 300, 200] }),
        new Date("2026-01-06T00:00:00.000Z"),
      ),
    ).toHaveLength(1);

    const atThreshold = projectWithSpend(375);
    expect(
      atThreshold.detectAnomalies(
        detectionInput({ comparableSpentMinor: [400, 100, 300, 200] }),
        new Date("2026-01-06T00:00:00.000Z"),
      ),
    ).toHaveLength(0);
  });

  it("skips the rule with fewer than 3 comparables", () => {
    const project = projectWithSpend(1_000_000);

    const findings = project.detectAnomalies(
      detectionInput({ comparableSpentMinor: [10, 20] }),
      new Date("2026-01-06T00:00:00.000Z"),
    );

    expect(findings).toHaveLength(0);
  });
});

describe("anomaly rule: stalled", () => {
  function releasedNeverSpent(): FundedProject {
    const project = unwrap(
      FundedProject.sanction({
        id: PID,
        villageId: VID,
        name: "Road works",
        category: "road",
        fundSource: "mla",
        sanctioned: money(500_000),
      }),
    );
    expect(project.release(money(500_000), "2026-01-01T00:00:00.000Z").ok).toBe(true);
    return project;
  }

  it("flags an in_progress project with no expenditure after stalledAfterDays have elapsed", () => {
    const project = releasedNeverSpent();

    const findings = project.detectAnomalies(
      detectionInput({ stalledAfterDays: 60 }),
      new Date("2026-03-03T00:00:00.000Z"), // 61 days after release
    );

    expect(findings.map((f) => f.type)).toEqual(["stalled"]);
  });

  it("does not flag when exactly stalledAfterDays have elapsed", () => {
    const project = releasedNeverSpent();

    const findings = project.detectAnomalies(
      detectionInput({ stalledAfterDays: 60 }),
      new Date("2026-03-02T00:00:00.000Z"), // exactly 60 days
    );

    expect(findings).toHaveLength(0);
  });

  it("does not flag when an expenditure was recorded within the window after the last release", () => {
    const project = releasedNeverSpent();
    expect(project.recordExpenditure(money(1_000), "earthworks", "2026-01-20T00:00:00.000Z").ok).toBe(
      true,
    );

    const findings = project.detectAnomalies(
      detectionInput({ stalledAfterDays: 60 }),
      new Date("2026-06-01T00:00:00.000Z"),
    );

    expect(findings).toHaveLength(0);
  });

  it("flags when the only expenditures predate the last release", () => {
    const project = unwrap(
      FundedProject.sanction({
        id: PID,
        villageId: VID,
        name: "Road works",
        category: "road",
        fundSource: "mla",
        sanctioned: money(500_000),
      }),
    );
    expect(project.release(money(400_000), "2026-01-01T00:00:00.000Z").ok).toBe(true);
    expect(project.recordExpenditure(money(1_000), "earthworks", "2026-01-05T00:00:00.000Z").ok).toBe(
      true,
    );
    expect(project.release(money(100_000), "2026-02-01T00:00:00.000Z").ok).toBe(true);

    const findings = project.detectAnomalies(
      detectionInput({ stalledAfterDays: 30 }),
      new Date("2026-03-10T00:00:00.000Z"),
    );

    expect(findings.map((f) => f.type)).toEqual(["stalled"]);
  });

  it("respects a custom stalledAfterDays", () => {
    const project = releasedNeverSpent();

    expect(
      project.detectAnomalies(detectionInput({ stalledAfterDays: 10 }), new Date("2026-01-12T00:00:00.000Z")),
    ).toHaveLength(1);
  });

  it("does not flag a project that is not in_progress", () => {
    const project = releasedNeverSpent();
    expect(project.complete().ok).toBe(true);

    const findings = project.detectAnomalies(
      detectionInput({ stalledAfterDays: 60 }),
      new Date("2026-12-01T00:00:00.000Z"),
    );

    expect(findings).toHaveLength(0);
  });
});

describe("anomaly rule: duplicate_funding", () => {
  it("flags when another active project shares the same villageId and category", () => {
    const project = projectWithSpend(0);

    const findings = project.detectAnomalies(
      detectionInput({
        otherActiveProjects: [{ villageId: "village-1", category: "school" }],
      }),
      new Date("2026-01-06T00:00:00.000Z"),
    );

    expect(findings.map((f) => f.type)).toEqual(["duplicate_funding"]);
  });

  it("does not flag for a different category or a different village", () => {
    const project = projectWithSpend(0);

    const findings = project.detectAnomalies(
      detectionInput({
        otherActiveProjects: [
          { villageId: "village-1", category: "bridge" },
          { villageId: "village-2", category: "school" },
        ],
      }),
      new Date("2026-01-06T00:00:00.000Z"),
    );

    expect(findings).toHaveLength(0);
  });
});

describe("idempotent re-detection", () => {
  it("does not append duplicate anomalies or return already-recorded findings on a repeat run", () => {
    // Stalled project plus a duplicate-funding pair -> 2 anomalies on the first run.
    const project = projectWithSpend(0);
    const input = detectionInput({
      stalledAfterDays: 60,
      otherActiveProjects: [{ villageId: "village-1", category: "school" }],
    });

    const first = project.detectAnomalies(input, new Date("2026-06-01T00:00:00.000Z"));
    expect(first.map((f) => f.type).sort()).toEqual(["duplicate_funding", "stalled"]);
    expect(project.anomalies).toHaveLength(2);

    const second = project.detectAnomalies(input, new Date("2026-06-02T00:00:00.000Z"));
    expect(second).toEqual([]);
    expect(project.anomalies).toHaveLength(2);
  });
});

describe("multiple findings", () => {
  it("appends one anomaly per triggered rule in a single detection run", () => {
    const project = unwrap(
      FundedProject.sanction({
        id: PID,
        villageId: VID,
        name: "School repair",
        category: "school",
        fundSource: "csr",
        sanctioned: money(1_000_000),
      }),
    );
    // Spend heavily, then a later release with no expenditure afterwards -> stalled.
    expect(project.release(money(900_000), "2026-01-01T00:00:00.000Z").ok).toBe(true);
    expect(project.recordExpenditure(money(900_000), "works", "2026-01-05T00:00:00.000Z").ok).toBe(true);
    expect(project.release(money(100_000), "2026-02-01T00:00:00.000Z").ok).toBe(true);

    const findings = project.detectAnomalies(
      {
        comparableSpentMinor: [100, 200, 300],
        stalledAfterDays: 60,
        otherActiveProjects: [{ villageId: "village-1", category: "school" }],
      },
      new Date("2026-06-01T00:00:00.000Z"),
    );

    expect(findings.map((f) => f.type).sort()).toEqual([
      "duplicate_funding",
      "overspend_vs_comparable",
      "stalled",
    ]);
    expect(project.anomalies).toHaveLength(3);
    for (const anomaly of project.anomalies) {
      expect(anomaly.detectedAt).toBe("2026-06-01T00:00:00.000Z");
      expect(anomaly.details.length).toBeGreaterThan(0);
    }
  });
});
