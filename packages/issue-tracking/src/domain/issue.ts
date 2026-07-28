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
  gps: GpsCoordinates;
  readonly reportedAt: string;
  private readonly _photoRefs: string[];
  private _status: IssueStatus;
  private _routedTo?: RoutedTo;
  private _routedAt?: string;
  private _progressStartedAt?: string;
  private _resolvedAt?: string;
  private _resolutionNote?: string;
  private _verifiedAt?: string;

  private constructor(props: IssueCreateProps) {
    this.id = props.id;
    this.villageId = props.villageId;
    this.category = props.category;
    this.description = props.description;
    this._photoRefs = [...props.photoRefs];
    this.gps = props.gps;
    this._status = "open";
    this.reportedAt = props.reportedAt;
  }

  static create(props: IssueCreateProps): Result<Issue> {
    const error = validateIssueProps(props);
    if (error) return err(error);
    return ok(new Issue(props));
  }

  /** Copy of the photo references — mutating it does not affect the issue. */
  get photoRefs(): string[] {
    return [...this._photoRefs];
  }

  get status(): IssueStatus {
    return this._status;
  }

  get routedTo(): RoutedTo | undefined {
    return this._routedTo;
  }

  get routedAt(): string | undefined {
    return this._routedAt;
  }

  get progressStartedAt(): string | undefined {
    return this._progressStartedAt;
  }

  get resolvedAt(): string | undefined {
    return this._resolvedAt;
  }

  get resolutionNote(): string | undefined {
    return this._resolutionNote;
  }

  get verifiedAt(): string | undefined {
    return this._verifiedAt;
  }

  route(decision: RoutedTo, occurredAt: string): Result<void> {
    if (this._status !== "open") {
      return err(`cannot route an issue with status ${this._status}`);
    }
    this._routedTo = decision;
    this._status = "routed";
    this._routedAt = occurredAt;
    return ok(undefined);
  }

  startProgress(occurredAt: string): Result<void> {
    if (this._status !== "routed") {
      return err(`cannot start progress on an issue with status ${this._status}`);
    }
    this._status = "in_progress";
    this._progressStartedAt = occurredAt;
    return ok(undefined);
  }

  resolve(resolutionNote: string, occurredAt: string): Result<void> {
    if (this._status !== "in_progress") {
      return err(`cannot resolve an issue with status ${this._status}`);
    }
    if (resolutionNote.trim().length === 0) {
      return err("resolutionNote must not be empty");
    }
    this._status = "resolved";
    this._resolvedAt = occurredAt;
    this._resolutionNote = resolutionNote;
    return ok(undefined);
  }

  verify(occurredAt: string): Result<void> {
    if (this._status !== "resolved") {
      return err(`cannot verify an issue with status ${this._status}`);
    }
    this._status = "verified";
    this._verifiedAt = occurredAt;
    return ok(undefined);
  }
}
