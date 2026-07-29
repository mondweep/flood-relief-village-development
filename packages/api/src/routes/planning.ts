import { planId, villageId } from "@afrip/shared-kernel";
import type { GoalId, MilestoneId, PlanArea } from "@afrip/development-planning";
import { badRequest, fromResult, json, notFound, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import { asObject, requiredString } from "../validate.js";
import type { RouteDeps } from "./deps.js";

export function registerPlanningRoutes(router: Router, _deps: RouteDeps): void {
  // ADR 0010: the platform is resolved PER REQUEST off `ctx`, never captured
  // from `deps.runtime.platform` at registration. The long-lived platform
  // stamps `system` onto what it publishes; only the request-scoped one knows
  // who is acting.
  const planning = (ctx: RequestContext) => ctx.platform.developmentPlanning;

  /**
   * One plan per village — the use case rejects a second one, which is the
   * "one village, one plan" rule living in the domain rather than in a unique
   * index nobody reads.
   */
  router.post("/villages/:id/plan", async (ctx: RequestContext): Promise<HttpResponse> => {
    const village = villageId(ctx.params["id"] ?? "");
    if (!village.ok) return badRequest(village.error);

    return fromResult(await planning(ctx).createPlan.execute({ villageId: village.value }), 201);
  });

  router.post("/plans/:id/goals", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const area = requiredString(body.value, "area");
    if (!area.ok) return badRequest(area.error);
    const description = requiredString(body.value, "description");
    if (!description.ok) return badRequest(description.error);

    const plan = planId(ctx.params["id"] ?? "");
    if (!plan.ok) return badRequest(plan.error);

    // `area` is an enum the aggregate validates; the cast only satisfies the
    // signature, it does not assert the value is valid.
    return fromResult(
      await planning(ctx).addGoal.execute({
        planId: plan.value,
        area: area.value as PlanArea,
        description: description.value,
      }),
      201,
    );
  });

  router.post(
    "/plans/:id/goals/:goalId/milestones",
    async (ctx: RequestContext): Promise<HttpResponse> => {
      const body = asObject(ctx.body);
      if (!body.ok) return badRequest(body.error);

      const title = requiredString(body.value, "title");
      if (!title.ok) return badRequest(title.error);
      const targetDate = requiredString(body.value, "targetDate");
      if (!targetDate.ok) return badRequest(targetDate.error);

      const plan = planId(ctx.params["id"] ?? "");
      if (!plan.ok) return badRequest(plan.error);

      return fromResult(
        await planning(ctx).addMilestone.execute({
          planId: plan.value,
          goalId: (ctx.params["goalId"] ?? "") as GoalId,
          title: title.value,
          targetDate: targetDate.value,
        }),
        201,
      );
    },
  );

  router.post(
    "/plans/:id/goals/:goalId/milestones/:milestoneId/complete",
    async (ctx: RequestContext): Promise<HttpResponse> => {
      const plan = planId(ctx.params["id"] ?? "");
      if (!plan.ok) return badRequest(plan.error);

      return fromResult(
        await planning(ctx).completeMilestone.execute({
          planId: plan.value,
          goalId: (ctx.params["goalId"] ?? "") as GoalId,
          milestoneId: (ctx.params["milestoneId"] ?? "") as MilestoneId,
        }),
      );
    },
  );

  /**
   * The village's plan with its progress rollup. Served through the plan
   * repository because Development Planning exposes no village -> plan query
   * use case; `GetProgress` is then run over the plan we found, so the
   * percentages are the aggregate's own arithmetic and not a second
   * implementation of it living here.
   */
  router.get("/villages/:id/plan", async (ctx: RequestContext): Promise<HttpResponse> => {
    const village = villageId(ctx.params["id"] ?? "");
    if (!village.ok) return badRequest(village.error);

    const plan = await planning(ctx).planRepository.findByVillage(village.value);
    if (plan === null) return notFound(`plan not found for village: ${village.value}`);

    const progress = await planning(ctx).getProgress.execute({ planId: plan.id });
    if (!progress.ok) return badRequest(progress.error);

    return json(200, {
      planId: plan.id,
      villageId: plan.villageId,
      goals: plan.goals,
      progress: progress.value,
    });
  });
}
