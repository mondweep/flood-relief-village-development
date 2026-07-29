import type { AidType, BeneficiaryCategory, ProviderType } from "@afrip/beneficiary-registry";
import { badRequest, fromResult, fromResultWith, json, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import { asObject, optionalString, requiredString } from "../validate.js";
import type { RouteDeps } from "./deps.js";

export function registerBeneficiaryRoutes(router: Router, deps: RouteDeps): void {
  // ADR 0010: the platform is resolved PER REQUEST off `ctx`, never captured
  // from `deps.runtime.platform` at registration. The long-lived platform
  // stamps `system` onto what it publishes; only the request-scoped one knows
  // who is acting.
  const beneficiaries = (ctx: RequestContext) => ctx.platform.beneficiaryRegistry;

  router.post("/beneficiaries", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const villageId = requiredString(body.value, "villageId");
    if (!villageId.ok) return badRequest(villageId.error);
    const name = requiredString(body.value, "name");
    if (!name.ok) return badRequest(name.error);
    const category = requiredString(body.value, "category");
    if (!category.ok) return badRequest(category.error);

    return fromResult(
      await beneficiaries(ctx).registerBeneficiary.execute({
        villageId: villageId.value,
        name: name.value,
        category: category.value as BeneficiaryCategory,
      }),
      201,
    );
  });

  /**
   * Village roster. Served from the API's event-sourced directory (see
   * projections.ts) — identifiers, categories and aid counts only, never names.
   */
  router.get("/villages/:id/beneficiaries", async (ctx: RequestContext): Promise<HttpResponse> => {
    const villageId = ctx.params["id"] ?? "";
    if (villageId.trim().length === 0) return badRequest("VillageId must be a non-empty string");
    return json(200, {
      villageId,
      beneficiaries: deps.runtime.beneficiaryDirectory.listByVillage(villageId),
    });
  });

  router.post("/beneficiaries/:id/aid", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const aidType = requiredString(body.value, "aidType");
    if (!aidType.ok) return badRequest(aidType.error);
    const providerId = requiredString(body.value, "providerId");
    if (!providerId.ok) return badRequest(providerId.error);
    const providerType = requiredString(body.value, "providerType");
    if (!providerType.ok) return badRequest(providerType.error);
    const notes = optionalString(body.value, "notes");
    if (!notes.ok) return badRequest(notes.error);

    return fromResult(
      await beneficiaries(ctx).recordAid.execute({
        beneficiaryId: ctx.params["id"] ?? "",
        aidType: aidType.value as AidType,
        providerId: providerId.value,
        providerType: providerType.value as ProviderType,
        ...(notes.value === undefined ? {} : { notes: notes.value }),
      }),
      201,
    );
  });

  router.post("/beneficiaries/:id/follow-ups", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);
    const dueAt = requiredString(body.value, "dueAt");
    if (!dueAt.ok) return badRequest(dueAt.error);

    return fromResult(
      await beneficiaries(ctx).scheduleFollowUp.execute({
        beneficiaryId: ctx.params["id"] ?? "",
        dueAt: dueAt.value,
      }),
      201,
    );
  });

  router.post(
    "/beneficiaries/:id/follow-ups/:followUpId/complete",
    async (ctx: RequestContext): Promise<HttpResponse> =>
      fromResult(
        await beneficiaries(ctx).completeFollowUp.execute({
          beneficiaryId: ctx.params["id"] ?? "",
          followUpId: ctx.params["followUpId"] ?? "",
        }),
      ),
  );

  /** Operational worklist. Authenticated: unlike the roster, this one carries names. */
  router.get("/follow-ups/overdue", async (ctx: RequestContext): Promise<HttpResponse> =>
    fromResultWith(await beneficiaries(ctx).listOverdueFollowUps.execute(), (list) => ({ followUps: list })),
  );
}
