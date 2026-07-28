export type {
  GpsCoordinates,
  IssueCategory,
  IssueCreateProps,
  IssueRestoreProps,
  IssueStatus,
  PartyType,
  RoutedTo,
} from "./domain/issue.js";
export { Issue, isIssueCategory, isIssueStatus, isPartyType } from "./domain/issue.js";

export type { LeadNgo } from "./domain/routing-policy.js";
export { determineRouting } from "./domain/routing-policy.js";

export type { AssignmentLookup, IssueRepository } from "./application/ports.js";

export {
  ReportIssue,
  type ReportIssueDeps,
  type ReportIssueInput,
  type ReportIssueOutput,
} from "./application/report-issue.js";

export {
  RouteIssue,
  type RouteIssueDeps,
  type RouteIssueInput,
  type RouteIssueOutput,
} from "./application/route-issue.js";

export {
  StartProgress,
  type StartProgressDeps,
  type StartProgressInput,
  type StartProgressOutput,
} from "./application/start-progress.js";

export {
  ResolveIssue,
  type ResolveIssueDeps,
  type ResolveIssueInput,
  type ResolveIssueOutput,
} from "./application/resolve-issue.js";

export {
  VerifyResolution,
  type VerifyResolutionDeps,
  type VerifyResolutionInput,
  type VerifyResolutionOutput,
} from "./application/verify-resolution.js";

export { InMemoryIssueRepository } from "./adapters/in-memory-issue-repository.js";

export {
  ISSUES_TABLE,
  SupabaseIssueRepository,
  fromRow as issueFromRow,
  toRow as issueToRow,
  type IssueRow,
} from "./adapters/supabase-issue-repository.js";
