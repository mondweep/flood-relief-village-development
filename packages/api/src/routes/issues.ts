import type { IssueCategory } from "@afrip/issue-tracking";
import { badRequest, fromResult, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import { asObject, optionalStringArray, requiredCoordinates, requiredString } from "../validate.js";
import type { RouteDeps } from "./deps.js";

export function registerIssueRoutes(router: Router, _deps: RouteDeps): void {
  // ADR 0010: the platform is resolved PER REQUEST off `ctx`, never captured
  // from `deps.runtime.platform` at registration. The long-lived platform
  // stamps `system` onto what it publishes; only the request-scoped one knows
  // who is acting.
  const issues = (ctx: RequestContext) => ctx.platform.issueTracking;

  router.post("/issues", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const villageId = requiredString(body.value, "villageId");
    if (!villageId.ok) return badRequest(villageId.error);
    const category = requiredString(body.value, "category");
    if (!category.ok) return badRequest(category.error);
    const description = requiredString(body.value, "description");
    if (!description.ok) return badRequest(description.error);
    const photoRefs = optionalStringArray(body.value, "photoRefs");
    if (!photoRefs.ok) return badRequest(photoRefs.error);
    const gps = requiredCoordinates(body.value, "gps");
    if (!gps.ok) return badRequest(gps.error);

    return fromResult(
      await issues(ctx).reportIssue.execute({
        villageId: villageId.value,
        category: category.value as IssueCategory,
        description: description.value,
        photoRefs: photoRefs.value,
        gps: gps.value,
      }),
      201,
    );
  });

  /** Applies the routing policy: lead NGO where one is assigned, else a government department. */
  router.post("/issues/:id/route", async (ctx: RequestContext): Promise<HttpResponse> =>
    fromResult(await issues(ctx).routeIssue.execute({ issueId: ctx.params["id"] ?? "" })),
  );

  router.post("/issues/:id/start", async (ctx: RequestContext): Promise<HttpResponse> =>
    fromResult(await issues(ctx).startProgress.execute({ issueId: ctx.params["id"] ?? "" })),
  );

  router.post("/issues/:id/resolve", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);
    const resolutionNote = requiredString(body.value, "resolutionNote");
    if (!resolutionNote.ok) return badRequest(resolutionNote.error);

    return fromResult(
      await issues(ctx).resolveIssue.execute({
        issueId: ctx.params["id"] ?? "",
        resolutionNote: resolutionNote.value,
      }),
    );
  });

  router.post("/issues/:id/verify", async (ctx: RequestContext): Promise<HttpResponse> =>
    fromResult(await issues(ctx).verifyResolution.execute({ issueId: ctx.params["id"] ?? "" })),
  );
}
