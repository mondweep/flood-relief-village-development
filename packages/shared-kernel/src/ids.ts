import { err, ok, type Result } from "./result.js";

declare const brand: unique symbol;
export type Branded<T, B> = T & { readonly [brand]: B };

export type VillageId = Branded<string, "VillageId">;
export type NgoId = Branded<string, "NgoId">;
export type AssignmentId = Branded<string, "AssignmentId">;
export type BeneficiaryId = Branded<string, "BeneficiaryId">;
export type ProjectId = Branded<string, "ProjectId">;
export type IssueId = Branded<string, "IssueId">;
export type VolunteerId = Branded<string, "VolunteerId">;
export type PlanId = Branded<string, "PlanId">;
export type SignalId = Branded<string, "SignalId">;
export type AlertId = Branded<string, "AlertId">;

function brandedId<B extends string>(kind: B) {
  return (raw: string): Result<Branded<string, B>> => {
    if (raw.trim().length === 0) return err(`${kind} must be a non-empty string`);
    return ok(raw as Branded<string, B>);
  };
}

export const villageId = brandedId("VillageId");
export const ngoId = brandedId("NgoId");
export const assignmentId = brandedId("AssignmentId");
export const beneficiaryId = brandedId("BeneficiaryId");
export const projectId = brandedId("ProjectId");
export const issueId = brandedId("IssueId");
export const volunteerId = brandedId("VolunteerId");
export const planId = brandedId("PlanId");
export const signalId = brandedId("SignalId");
export const alertId = brandedId("AlertId");
