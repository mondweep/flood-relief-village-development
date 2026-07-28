/** FR-FM-4: flag delayed, duplicate-funded and over-spending projects. */
import { type Clock, type EventPublisher, type Result, err, ok } from '../../../shared/index.js';
import {
  type Anomaly,
  type AnomalyDetectorConfig,
  DEFAULT_ANOMALY_CONFIG,
  anomalyFlagged,
  detectAnomalies,
} from '../domain/index.js';
import { parseProjectId } from './boundary.js';
import type { ComparableProjectsQuery, ProjectRepository } from './ports.js';

export interface DetectAnomaliesDeps {
  readonly projects: ProjectRepository;
  readonly comparables: ComparableProjectsQuery;
  readonly events: EventPublisher;
  readonly clock: Clock;
  readonly config?: AnomalyDetectorConfig;
}

export interface DetectAnomaliesCommand {
  readonly projectId: string;
}

export interface DetectAnomalies {
  execute(command: DetectAnomaliesCommand): Promise<Result<readonly Anomaly[]>>;
}

export const makeDetectAnomalies = (deps: DetectAnomaliesDeps): DetectAnomalies => ({
  async execute(command) {
    const id = parseProjectId(command.projectId);
    if (!id.ok) return id;

    const project = await deps.projects.findById(id.value);
    if (project === null) return err('PROJECT_NOT_FOUND', `no funded project ${command.projectId}`);

    const villageProjects = await deps.projects.findByVillage(project.villageId);
    const comparables = await deps.comparables.findComparable({
      category: project.category,
      excludeProjectId: project.id,
    });

    const now = deps.clock.now();
    const anomalies = detectAnomalies({
      project,
      villageProjects,
      comparables,
      now,
      config: deps.config ?? DEFAULT_ANOMALY_CONFIG,
    });

    if (anomalies.length > 0) {
      await deps.events.publish(anomalies.map((anomaly) => anomalyFlagged(anomaly, now)));
    }

    return ok(anomalies);
  },
});
