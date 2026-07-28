/** FR-FM-3: attach geo-tagged evidence to a funded project (append-only). */
import {
  type Clock,
  type EventPublisher,
  type Result,
  err,
  geoPoint,
  ok,
} from '../../../shared/index.js';
import {
  type FundedProject,
  attachEvidence,
  evidenceAttached,
  evidenceItem,
  isEvidenceKind,
} from '../domain/index.js';
import { parseProjectId } from './boundary.js';
import type { ProjectRepository } from './ports.js';

export interface AttachEvidenceDeps {
  readonly projects: ProjectRepository;
  readonly events: EventPublisher;
  readonly clock: Clock;
}

export interface AttachEvidenceCommand {
  readonly projectId: string;
  readonly kind: string;
  readonly uri: string;
  readonly attachedBy: string;
  readonly location?: { readonly lat: number; readonly lng: number };
}

export interface AttachEvidence {
  execute(command: AttachEvidenceCommand): Promise<Result<FundedProject>>;
}

export const makeAttachEvidence = (deps: AttachEvidenceDeps): AttachEvidence => ({
  async execute(command) {
    const id = parseProjectId(command.projectId);
    if (!id.ok) return id;

    if (!isEvidenceKind(command.kind)) {
      return err('UNKNOWN_EVIDENCE_KIND', `unknown evidence kind: ${command.kind}`);
    }

    const location = command.location;
    const point = location === undefined ? undefined : geoPoint(location.lat, location.lng);
    if (point !== undefined && !point.ok) return point;

    const project = await deps.projects.findById(id.value);
    if (project === null) return err('PROJECT_NOT_FOUND', `no funded project ${command.projectId}`);

    const attachedAt = deps.clock.now();
    const item = evidenceItem({
      kind: command.kind,
      uri: command.uri,
      attachedBy: command.attachedBy,
      attachedAt,
      ...(point !== undefined && point.ok ? { location: point.value } : {}),
    });
    if (!item.ok) return item;

    const updated = attachEvidence(project, item.value);
    if (!updated.ok) return updated;

    await deps.projects.save(updated.value);
    await deps.events.publish([evidenceAttached(updated.value, item.value, attachedAt)]);

    return ok(updated.value);
  },
});
