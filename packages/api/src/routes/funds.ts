import { projectId, toMajorUnits, villageId } from "@afrip/shared-kernel";
import type { FundedProject } from "@afrip/fund-monitoring";
import { DEFAULT_FUND_CURRENCY, toFundProjectView } from "../fund-view.js";
import {
  badRequest,
  fromResult,
  fromResultWith,
  json,
  type HttpResponse,
} from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import {
  asObject,
  optionalMajorAmountArray,
  optionalNumber,
  optionalObjectArray,
  optionalString,
  requiredMajorAmount,
  requiredString,
} from "../validate.js";
import type { RouteDeps } from "./deps.js";

/** Statuses a project can still be spending against — the "active" set. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["sanctioned", "in_progress"]);

/**
 * MONEY ON THIS SURFACE IS RUPEES (major units), and every field says so:
 * `sanctionedInr`, `amountInr`, `comparableSpentInr`. A caller sanctioning
 * ₹50,000 sends `50000`, not `5000000`.
 *
 * The conversion to integer paise happens here at the boundary and nowhere
 * else — `requiredMajorAmount` hands back a `Money`, the use cases below still
 * take `...Minor`, and the aggregate's `spent <= released <= sanctioned` ladder
 * stays integer arithmetic end to end. Responses convert back the same way, in
 * `fund-view.ts`.
 */

export function registerFundRoutes(router: Router, deps: RouteDeps): void {
  // ADR 0010: the platform is resolved PER REQUEST off `ctx`, never captured
  // from `deps.runtime.platform` at registration. The long-lived platform
  // stamps `system` onto what it publishes; only the request-scoped one knows
  // who is acting.
  const funds = (ctx: RequestContext) => ctx.platform.fundMonitoring;

  /**
   * Sanctions a project. `sanctionedInr` is rupees — `50000` is ₹50,000.
   *
   * Rupees and paise are both accepted forms of the same figure (`1500.75` is
   * ₹1,500.75), but a THIRD decimal is refused with a 400 rather than rounded:
   * `1234.567` is not a sum of money anyone meant, and quietly booking
   * ₹1,234.57 would put a number in an audited ledger that nobody typed.
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
    const sanctioned = requiredMajorAmount(body.value, "sanctionedInr");
    if (!sanctioned.ok) return badRequest(sanctioned.error);

    // category and fundSource are enums the aggregate validates; we only assert shape.
    return fromResult(
      await funds(ctx).sanctionProject.execute({
        villageId: village.value,
        name: name.value,
        category: category.value,
        fundSource: fundSource.value,
        sanctionedMinor: sanctioned.value.amountMinor,
      }),
      201,
    );
  });

  router.post("/projects/:id/release", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);
    const amount = requiredMajorAmount(body.value, "amountInr");
    if (!amount.ok) return badRequest(amount.error);

    return fromResultWith(
      await funds(ctx).releaseFunds.execute({
        projectId: ctx.params["id"] ?? "",
        amountMinor: amount.value.amountMinor,
      }),
      (released) => ({
        projectId: released.projectId,
        currency: DEFAULT_FUND_CURRENCY,
        totalReleasedInr: toMajorUnits(released.totalReleasedMinor),
        status: released.status,
      }),
      201,
    );
  });

  router.post("/projects/:id/expenditure", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const amount = requiredMajorAmount(body.value, "amountInr");
    if (!amount.ok) return badRequest(amount.error);
    const description = requiredString(body.value, "description");
    if (!description.ok) return badRequest(description.error);
    const evidenceRef = optionalString(body.value, "evidenceRef");
    if (!evidenceRef.ok) return badRequest(evidenceRef.error);

    return fromResultWith(
      await funds(ctx).recordExpenditure.execute({
        projectId: ctx.params["id"] ?? "",
        amountMinor: amount.value.amountMinor,
        description: description.value,
        ...(evidenceRef.value === undefined ? {} : { evidenceRef: evidenceRef.value }),
      }),
      (spent) => ({
        projectId: spent.projectId,
        currency: DEFAULT_FUND_CURRENCY,
        totalSpentInr: toMajorUnits(spent.totalSpentMinor),
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
   * `comparableSpentInr` and `otherActiveProjects` are the rules' evidence.
   * When the caller omits them the route derives them from the project register
   * — comparables are the completed/verified projects in the same category, the
   * duplicate-funding candidates are every other still-active project — so a
   * bare POST runs the rules against real peers instead of against nothing. A
   * caller that supplies either one wins, including with an empty array, which
   * is how you say "there are no comparables" rather than "go and find some".
   *
   * `comparableSpentInr` is rupees like every other money field on this
   * surface; the derived figures never leave paise because they are read
   * straight off the register.
   */
  router.post("/projects/:id/detect-anomalies", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body ?? {});
    if (!body.ok) return badRequest(body.error);

    const comparableSpent = optionalMajorAmountArray(body.value, "comparableSpentInr");
    if (!comparableSpent.ok) return badRequest(comparableSpent.error);
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
      comparableSpent.value === undefined || otherActiveProjects.value === undefined
        ? await deriveAnomalyEvidence(ctx, id)
        : null;

    return fromResult(
      await funds(ctx).detectAnomalies.execute({
        projectId: id,
        comparableSpentMinor:
          comparableSpent.value?.map((money) => money.amountMinor) ??
          derived?.comparableSpentMinor ??
          [],
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
