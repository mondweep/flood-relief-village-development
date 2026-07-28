import { err, ok, type IssueId, type Result, type VillageId } from "@afrip/shared-kernel";

export type IssueCategory =
  | "infrastructure"
  | "water"
  | "education"
  | "health"
  | "food"
  | "corruption"
  | "other";

const CATEGORIES: readonly IssueCategory[] = [
  "infrastructure",
  "water",
  "education",
  "health",
  "food",
  "corruption",
  "other",
];

export function isIssueCategory(value: string): value is IssueCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

export type IssueStatus = "open" | "routed" | "in_progress" | "resolved" | "verified";

export type PartyType = "lead_ngo" | "government_department";

export interface GpsCoordinates {
  readonly lat: number;
  readonly lng: number;
}

export interface RoutedTo {
  readonly partyType: PartyType;
  readonly party: string;
}

export interface IssueCreateProps {
  id: IssueId;
  villageId: VillageId;
  category: IssueCategory;
  description: string;
  photoRefs: string[];
  gps: GpsCoordinates;
  reportedAt: string;
}

function validateGps(gps: GpsCoordinates): string | null {
  if (gps.lat < -90 || gps.lat > 90) return "gps.lat must be between -90 and 90";
  if (gps.lng < -180 || gps.lng > 180) return "gps.lng must be between -180 and 180";
  return null;
}

function validateIssueProps(props: IssueCreateProps): string | null {
  if (props.description.trim().length === 0) return "description must not be empty";
  if (!isIssueCategory(props.category)) return `invalid category: ${String(props.category)}`;
  return validateGps(props.gps);
}

export class Issue {
  readonly id: IssueId;
  readonly villageId: VillageId;
  readonly category: IssueCategory;
  description: string;
  photoRefs: string[];
  gps: GpsCoordinates;
  status: IssueStatus;
  readonly reportedAt: string;
  routedTo?: RoutedTo;
  routedAt?: string;
  progressStartedAt?: string;
  resolvedAt?: string;
  resolutionNote?: string;
  verifiedAt?: string;

  private constructor(props: IssueCreateProps) {
    this.id = props.id;
    this.villageId = props.villageId;
    this.category = props.category;
    this.description = props.description;
    this.photoRefs = props.photoRefs;
    this.gps = props.gps;
    this.status = "open";
    this.reportedAt = props.reportedAt;
  }

  static create(props: IssueCreateProps): Result<Issue> {
    const error = validateIssueProps(props);
    if (error) return err(error);
    return ok(new Issue(props));
  }

  route(decision: RoutedTo, occurredAt: string): Result<void> {
    if (this.status !== "open") {
      return err(`cannot route an issue with status ${this.status}`);
    }
    this.routedTo = decision;
    this.status = "routed";
    this.routedAt = occurredAt;
    return ok(undefined);
  }

  startProgress(occurredAt: string): Result<void> {
    if (this.status !== "routed") {
      return err(`cannot start progress on an issue with status ${this.status}`);
    }
    this.status = "in_progress";
    this.progressStartedAt = occurredAt;
    return ok(undefined);
  }

  resolve(resolutionNote: string, occurredAt: string): Result<void> {
    if (this.status !== "in_progress") {
      return err(`cannot resolve an issue with status ${this.status}`);
    }
    if (resolutionNote.trim().length === 0) {
      return err("resolutionNote must not be empty");
    }
    this.status = "resolved";
    this.resolvedAt = occurredAt;
    this.resolutionNote = resolutionNote;
    return ok(undefined);
  }

  verify(occurredAt: string): Result<void> {
    if (this.status !== "resolved") {
      return err(`cannot verify an issue with status ${this.status}`);
    }
    this.status = "verified";
    this.verifiedAt = occurredAt;
    return ok(undefined);
  }
}
