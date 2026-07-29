import { villageId, volunteerId } from "@afrip/shared-kernel";
import type { Availability, Volunteer } from "@afrip/volunteer-management";
import { badRequest, fromResult, json, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import { asObject, requiredNumber, requiredString, requiredStringArray } from "../validate.js";
import type { RouteDeps } from "./deps.js";

export interface VolunteerView {
  readonly id: string;
  readonly name: string;
  readonly skills: readonly string[];
  readonly languages: readonly string[];
  readonly location: string;
  readonly availability: string;
  readonly totalHours: number;
  readonly assignments: readonly {
    readonly id: string;
    readonly villageId: string;
    readonly task: string;
    readonly assignedAt: string;
    readonly hours: number;
  }[];
}

function toVolunteerView(volunteer: Volunteer): VolunteerView {
  return {
    id: volunteer.id,
    name: volunteer.name,
    skills: [...volunteer.skills],
    languages: [...volunteer.languages],
    location: volunteer.location,
    availability: volunteer.availability,
    totalHours: volunteer.getTotalHours(),
    assignments: volunteer.assignments.map((assignment) => ({ ...assignment })),
  };
}

export function registerVolunteerRoutes(router: Router, _deps: RouteDeps): void {
  // ADR 0010: the platform is resolved PER REQUEST off `ctx`, never captured
  // from `deps.runtime.platform` at registration. The long-lived platform
  // stamps `system` onto what it publishes; only the request-scoped one knows
  // who is acting.
  const volunteers = (ctx: RequestContext) => ctx.platform.volunteerManagement;

  router.post("/volunteers", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const name = requiredString(body.value, "name");
    if (!name.ok) return badRequest(name.error);
    const skills = requiredStringArray(body.value, "skills");
    if (!skills.ok) return badRequest(skills.error);
    const languages = requiredStringArray(body.value, "languages");
    if (!languages.ok) return badRequest(languages.error);
    const location = requiredString(body.value, "location");
    if (!location.ok) return badRequest(location.error);

    return fromResult(
      await volunteers(ctx).registerVolunteer.execute({
        name: name.value,
        skills: skills.value,
        languages: languages.value,
        location: location.value,
      }),
      201,
    );
  });

  /**
   * Registered before `/volunteers/:id/...` would matter — the router matches in
   * registration order, and this literal path must not be shadowed by a
   * parameterised one. It is a distinct segment count from every route below, so
   * the ordering is belt and braces rather than load-bearing.
   */
  router.get("/volunteers/leaderboard", async (ctx: RequestContext): Promise<HttpResponse> =>
    fromResult(await volunteers(ctx).leaderboard.execute()),
  );

  router.get("/volunteers", async (ctx: RequestContext): Promise<HttpResponse> => {
    const all = await volunteers(ctx).volunteerRepository.listAll();
    return json(200, { volunteers: all.map(toVolunteerView) });
  });

  router.patch("/volunteers/:id/availability", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);
    const availability = requiredString(body.value, "availability");
    if (!availability.ok) return badRequest(availability.error);

    const id = volunteerId(ctx.params["id"] ?? "");
    if (!id.ok) return badRequest(id.error);

    // The aggregate owns the enum; passing the raw string through means an
    // invalid value comes back as the domain's own message, not ours.
    return fromResult(
      await volunteers(ctx).setAvailability.execute({
        volunteerId: id.value,
        availability: availability.value as Availability,
      }),
    );
  });

  router.post("/volunteers/:id/assignments", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const village = requiredString(body.value, "villageId");
    if (!village.ok) return badRequest(village.error);
    const task = requiredString(body.value, "task");
    if (!task.ok) return badRequest(task.error);

    const id = volunteerId(ctx.params["id"] ?? "");
    if (!id.ok) return badRequest(id.error);
    const parsedVillage = villageId(village.value);
    if (!parsedVillage.ok) return badRequest(parsedVillage.error);

    return fromResult(
      await volunteers(ctx).assignVolunteer.execute({
        volunteerId: id.value,
        villageId: parsedVillage.value,
        task: task.value,
      }),
      201,
    );
  });

  router.post("/volunteers/:id/hours", async (ctx: RequestContext): Promise<HttpResponse> => {
    const body = asObject(ctx.body);
    if (!body.ok) return badRequest(body.error);

    const assignmentId = requiredString(body.value, "assignmentId");
    if (!assignmentId.ok) return badRequest(assignmentId.error);
    const hours = requiredNumber(body.value, "hours");
    if (!hours.ok) return badRequest(hours.error);

    const id = volunteerId(ctx.params["id"] ?? "");
    if (!id.ok) return badRequest(id.error);

    return fromResult(
      await volunteers(ctx).logHours.execute({
        volunteerId: id.value,
        assignmentId: assignmentId.value,
        hours: hours.value,
      }),
      201,
    );
  });
}
