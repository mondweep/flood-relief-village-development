import {
  err,
  ok,
  projectId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type Result,
} from "@afrip/shared-kernel";
import type { Anomaly } from "../domain/funded-project.js";
import type { ProjectRepository } from "./ports.js";

export const DEFAULT_STALLED_AFTER_DAYS = 60;

export interface DetectAnomaliesInput {
  projectId: string;
  /** Spent totals (minor units) of completed comparable projects. */
  comparableSpentMinor?: number[];
  /** Days without expenditure after the last release before flagging as stalled (default 60). */
  stalledAfterDays?: number;
  /** Other active (not completed/verified) projects for the duplicate-funding rule. */
  otherActiveProjects?: { villageId: string; category: string }[];
}

export interface DetectAnomaliesOutput {
  projectId: string;
  findings: Anomaly[];
}

export interface DetectAnomaliesDeps {
  repository: ProjectRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class DetectAnomalies {
  constructor(private readonly deps: DetectAnomaliesDeps) {}

  async execute(input: DetectAnomaliesInput): Promise<Result<DetectAnomaliesOutput>> {
    const pid = projectId(input.projectId);
    if (!pid.ok) return err(pid.error);

    const stalledAfterDays = input.stalledAfterDays ?? DEFAULT_STALLED_AFTER_DAYS;
    if (!Number.isFinite(stalledAfterDays) || stalledAfterDays <= 0) {
      return err("stalledAfterDays must be a positive number");
    }
    const comparableSpentMinor = input.comparableSpentMinor ?? [];
    if (comparableSpentMinor.some((v) => !Number.isFinite(v) || v < 0)) {
      return err("comparableSpentMinor must contain non-negative numbers");
    }

    const project = await this.deps.repository.findById(pid.value);
    if (!project) return err(`Project not found: ${input.projectId}`);

    const now = this.deps.clock.now();
    const findings = project.detectAnomalies(
      {
        comparableSpentMinor,
        stalledAfterDays,
        otherActiveProjects: input.otherActiveProjects ?? [],
      },
      now,
    );

    if (findings.length > 0) {
      await this.deps.repository.save(project);
      const events: DomainEvent[] = findings.map((finding) => ({
        name: "project.anomaly-flagged.v1",
        occurredAt: now.toISOString(),
        payload: {
          projectId: project.id as string,
          villageId: project.villageId as string,
          type: finding.type,
          details: finding.details,
          detectedAt: finding.detectedAt,
        },
      }));
      await this.deps.eventPublisher.publish(events);
    }

    return ok({ projectId: project.id, findings });
  }
}
