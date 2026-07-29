import { projectId, villageId } from "@afrip/shared-kernel";
import type { FundedProject } from "@afrip/fund-monitoring";
import { toFundProjectView } from "../fund-view.js";
import { badRequest, fromResult, json, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import {
  asObject,
  optionalNumber,
  optionalNumberArray,
  optionalObjectArray,
  optionalString,
  requiredNumber,
  requiredString,
} from "../validate.js";
import type { RouteDeps } from "./deps.js";

/** Statuses a project can still be spending against — the "active" set. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["sanctioned", "in_progress"]);

export function registerFundRoutes(router: Router, deps: RouteDeps): void {
  // ADR 0010: the platform is resolved PER REQUEST off `ctx`, never captured
  // from `deps.runtime.platform` at registration. The long-lived platform
  // stamps `system` onto what it publishes; only the request-scoped one knows
  // who is acting.
  const funds = (ctx: RequestContext) => ctx.platform.fundMonitoring;

  /**
   * Sanctions a project. The amount is minor units (paise) as an integer —
   * `Money` refuses anything else, so a rupee float is rejected by the domain
   * rather than silently truncated.
   */
  router.post("/projects", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const village = requiredString(body.value, "villageId");
    if (!village.ok) return badRequest(village.error);
    const name = requiredString(body.value, "name");
    if (!name.ok) return badRequest(name.error);
    const category = requiredString(body.value, "category");
    if (!category.ok) return badRequest(category.error);
    const fundSource = requiredString(body.value, "fundSource");
    if (!fundSource.ok) return badRequest(fundSource.error);
    const sanctionedMinor = requiredNumber(body.value, "sanctionedMinor");
    if (!sanctionedMinor.ok) return badRequest(sanctionedMinor.error);

    // category and fundSource are enums the aggregate validates; we only assert shape.
    return fromResult(
      await funds(ctx).sanctionProject.execute({
        villageId: village.value,
        name: name.value,
        category: category.value,
        fundSource: fundSource.value,
        sanctionedMinor: sanctionedMinor.value,
      }),
      201,
    );
  });

  router.post("/projects/:id/release", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);
    const amountMinor = requiredNumber(body.value, "amountMinor");
    if (!amountMinor.ok) return badRequest(amountMinor.error);

    return fromResult(
      await funds(ctx).releaseFunds.execute({
        projectId: ctx.params["id"] ?? "",
        amountMinor: amountMinor.value,
      }),
      201,
    );
  });

  router.post("/projects/:id/expenditure", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const amountMinor = requiredNumber(body.value, "amountMinor");
    if (!amountMinor.ok) return badRequest(amountMinor.error);
    const description = requiredString(body.value, "description");
    if (!description.ok) return badRequest(description.error);
    const evidenceRef = optionalString(body.value, "evidenceRef");
    if (!evidenceRef.ok) return badRequest(evidenceRef.error);

    return fromResult(
      await funds(ctx).recordExpenditure.execute({
        projectId: ctx.params["id"] ?? "",
        amountMinor: amountMinor.value,
        description: description.value,
        ...(evidenceRef.value === undefined ? {} : { evidenceRef: evidenceRef.value }),
      }),
      201,
    );
  });

  router.post("/projects/:id/complete", async (ctx: RequestContext): Promise<HttpResponse> =>
    fromResult(await funds(ctx).completeProject.execute({ projectId: ctx.params["id"] ?? "" })),
  );

  router.post("/projects/:id/verify", async (ctx: RequestContext): Promise<HttpResponse> =>
    fromResult(await funds(ctx).verifyProject.execute({ projectId: ctx.params["id"] ?? "" })),
  );

  /**
   * Runs the anomaly rules. 200, not 201: it reports on a project rather than
   * creating a resource, and re-running it over unchanged state is idempotent
   * (the aggregate does not re-flag a finding it already holds).
   *
   * `comparableSpentMinor` and `otherActiveProjects` are the rules' evidence.
   * When the caller omits them the route derives them from the project register
   * — comparables are the completed/verified projects in the same category, the
   * duplicate-funding candidates are every other still-active project — so a
   * bare POST runs the rules against real peers instead of against nothing. A
   * caller that supplies either one wins, including with an empty array, which
   * is how you say "there are no comparables" rather than "go and find some".
   */
  router.post("/projects/:id/detect-anomalies", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body ?? {});
    if (!body.ok) return badRequest(body.error);

    const comparableSpentMinor = optionalNumberArray(body.value, "comparableSpentMinor");
    if (!comparableSpentMinor.ok) return badRequest(comparableSpentMinor.error);
    const stalledAfterDays = optionalNumber(body.value, "stalledAfterDays");
    if (!stalledAfterDays.ok) return badRequest(stalledAfterDays.error);
    const otherActiveProjects = optionalObjectArray(body.value, "otherActiveProjects");
    if (!otherActiveProjects.ok) return badRequest(otherActiveProjects.error);

    const parsedOthers: { villageId: string; category: string }[] = [];
    for (const entry of otherActiveProjects.value ?? []) {
      const village = requiredString(entry, "villageId");
      if (!village.ok) return badRequest(`otherActiveProjects[].${village.error}`);
      const category = requiredString(entry, "category");
      if (!category.ok) return badRequest(`otherActiveProjects[].${category.error}`);
      parsedOthers.push({ villageId: village.value, category: category.value });
    }

    const id = ctx.params["id"] ?? "";
    const derived =
      comparableSpentMinor.value === undefined || otherActiveProjects.value === undefined
        ? await deriveAnomalyEvidence(ctx, id)
        : null;

    return fromResult(
      await funds(ctx).detectAnomalies.execute({
        projectId: id,
        comparableSpentMinor: comparableSpentMinor.value ?? derived?.comparableSpentMinor ?? [],
        ...(stalledAfterDays.value === undefined ? {} : { stalledAfterDays: stalledAfterDays.value }),
        otherActiveProjects:
          otherActiveProjects.value === undefined
            ? (derived?.otherActiveProjects ?? [])
            : parsedOthers,
      }),
    );
  });

  router.get("/projects", async (ctx: RequestContext): Promise<HttpResponse> => {
    const projects = await funds(ctx).projectRepository.listAll();
    return json(200, { projects: projects.map(toFundProjectView) });
  });

  router.get("/villages/:id/projects", async (ctx: RequestContext): Promise<HttpResponse> => {
    const village = villageId(ctx.params["id"] ?? "");
    if (!village.ok) return badRequest(village.error);

    const projects = await funds(ctx).projectRepository.listByVillage(village.value);
    return json(200, { villageId: village.value, projects: projects.map(toFundProjectView) });
  });

  /** Peer evidence for the anomaly rules, read off the project register. */
  async function deriveAnomalyEvidence(ctx: RequestContext, rawId: string): Promise<{
    comparableSpentMinor: number[];
    otherActiveProjects: { villageId: string; category: string }[];
  } | null> {
    const parsed = projectId(rawId);
    if (!parsed.ok) return null;

    const all = await funds(ctx).projectRepository.listAll();
    const subject = all.find((project) => project.id === parsed.value);
    if (subject === undefined) return null;

    const others = all.filter((project) => project.id !== subject.id);
    return {
      comparableSpentMinor: others
        .filter(
          (project: FundedProject) =>
            project.category === subject.category && !ACTIVE_STATUSES.has(project.status),
        )
        .map((project) => project.spent.amountMinor),
      otherActiveProjects: others
        .filter((project) => ACTIVE_STATUSES.has(project.status))
        .map((project) => ({ villageId: project.villageId, category: project.category })),
    };
  }
}
