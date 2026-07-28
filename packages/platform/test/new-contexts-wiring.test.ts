import { describe, expect, it } from "vitest";
import { FixedClock, ok, planId, signalId, villageId, volunteerId, type Result } from "@afrip/shared-kernel";
import { createPlatform, type PlatformRepositories } from "@afrip/platform";
import type { FundedProject, ProjectRepository } from "@afrip/fund-monitoring";
import type { Volunteer, VolunteerRepository } from "@afrip/volunteer-management";
import type { DevelopmentPlan, PlanRepository } from "@afrip/development-planning";
import {
  KeywordSignalExtractor,
  type AlertRepository,
  type Extracted,
  type SignalExtractor,
  type SignalRepository,
  type SmartAlert,
  type Signal,
} from "@afrip/social-media-intelligence";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value;
}

const clock = (): FixedClock => new FixedClock(new Date("2026-07-01T00:00:00.000Z"));

/** Brands a raw id the way the HTTP boundary does, so no test needs a cast. */
const asVolunteer = (raw: string) => unwrap(volunteerId(raw));
const asVillage = (raw: string) => unwrap(villageId(raw));
const asPlan = (raw: string) => unwrap(planId(raw));
const asSignal = (raw: string) => unwrap(signalId(raw));

function platform(overrides: Parameters<typeof createPlatform>[0] = {}) {
  return createPlatform({ clock: clock(), ...overrides });
}

function platformWith(repositories: PlatformRepositories) {
  return platform({ repositories });
}

/** Records which port methods the composition root actually calls. */
function spy(): {
  calls: string[];
  project: ProjectRepository;
  volunteer: VolunteerRepository;
  plan: PlanRepository;
  signal: SignalRepository;
  alert: AlertRepository;
} {
  const calls: string[] = [];
  const note = (name: string): void => {
    calls.push(name);
  };

  return {
    calls,
    project: {
      findById: async () => (note("project.findById"), null),
      save: async (_project: FundedProject) => note("project.save"),
      listByVillage: async () => (note("project.listByVillage"), []),
      listAll: async () => (note("project.listAll"), []),
    },
    volunteer: {
      findById: async () => (note("volunteer.findById"), null),
      save: async (_volunteer: Volunteer) => note("volunteer.save"),
      listAll: async () => (note("volunteer.listAll"), []),
    },
    plan: {
      findById: async () => (note("plan.findById"), null),
      findByVillage: async () => (note("plan.findByVillage"), null),
      save: async (_plan: DevelopmentPlan) => note("plan.save"),
    },
    signal: {
      findById: async () => (note("signal.findById"), null),
      save: async (_signal: Signal) => note("signal.save"),
      listAll: async () => (note("signal.listAll"), []),
    },
    alert: {
      save: async (_alert: SmartAlert) => note("alert.save"),
      listAll: async () => (note("alert.listAll"), []),
    },
  };
}

const SANCTION_INPUT = {
  villageId: "village-1",
  name: "Rampur footbridge",
  category: "bridge",
  fundSource: "district",
  sanctionedMinor: 500_000_00,
};

describe("createPlatform — the four late-wired contexts", () => {
  describe("fund monitoring", () => {
    it("exposes every fund use case, working end to end on the in-memory default", async () => {
      const funds = platform().fundMonitoring;

      const sanctioned = unwrap(await funds.sanctionProject.execute(SANCTION_INPUT));
      const released = unwrap(
        await funds.releaseFunds.execute({ projectId: sanctioned.projectId, amountMinor: 200_000_00 }),
      );
      const spent = unwrap(
        await funds.recordExpenditure.execute({
          projectId: sanctioned.projectId,
          amountMinor: 50_000_00,
          description: "Piling contractor",
        }),
      );
      const completed = unwrap(await funds.completeProject.execute({ projectId: sanctioned.projectId }));
      const verified = unwrap(await funds.verifyProject.execute({ projectId: sanctioned.projectId }));

      expect(released.totalReleasedMinor).toBe(200_000_00);
      expect(spent.totalSpentMinor).toBe(50_000_00);
      expect(completed.status).toBe("completed");
      expect(verified.status).toBe("verified");
    });

    it("detects anomalies over the same repository the commands wrote to", async () => {
      const funds = platform().fundMonitoring;
      const sanctioned = unwrap(await funds.sanctionProject.execute(SANCTION_INPUT));

      const detected = unwrap(
        await funds.detectAnomalies.execute({
          projectId: sanctioned.projectId,
          otherActiveProjects: [{ villageId: "village-1", category: "bridge" }],
        }),
      );

      expect(detected.findings.map((finding) => finding.type)).toEqual(["duplicate_funding"]);
    });

    it("writes and reads through an injected project repository", async () => {
      const repos = spy();
      const funds = platformWith({ project: repos.project }).fundMonitoring;

      unwrap(await funds.sanctionProject.execute(SANCTION_INPUT));
      await funds.projectRepository.listAll();

      expect(repos.calls).toEqual(["project.save", "project.listAll"]);
      // The exposed read port must be the injected one, not a second instance.
      expect(funds.projectRepository).toBe(repos.project);
    });
  });

  describe("volunteer management", () => {
    it("registers, assigns, logs hours and ranks on the in-memory default", async () => {
      const volunteers = platform().volunteerManagement;

      const registered = unwrap(
        await volunteers.registerVolunteer.execute({
          name: "Anil Das",
          skills: ["first-aid"],
          languages: ["as", "hi"],
          location: "Dhemaji",
        }),
      );
      const assigned = unwrap(
        await volunteers.assignVolunteer.execute({
          volunteerId: asVolunteer(registered.volunteerId),
          villageId: asVillage("village-1"),
          task: "Relief distribution",
        }),
      );
      unwrap(
        await volunteers.logHours.execute({
          volunteerId: asVolunteer(registered.volunteerId),
          assignmentId: assigned.assignmentId,
          hours: 6,
        }),
      );

      const board = unwrap(await volunteers.leaderboard.execute());
      expect(board.entries).toEqual([
        { volunteerId: registered.volunteerId, name: "Anil Das", totalHours: 6 },
      ]);
    });

    it("changes availability through the aggregate", async () => {
      const volunteers = platform().volunteerManagement;
      const registered = unwrap(
        await volunteers.registerVolunteer.execute({
          name: "Anil Das",
          skills: [],
          languages: [],
          location: "Dhemaji",
        }),
      );

      const changed = unwrap(
        await volunteers.setAvailability.execute({
          volunteerId: asVolunteer(registered.volunteerId),
          availability: "unavailable",
        }),
      );

      expect(changed.previousAvailability).toBe("available");
    });

    it("writes through an injected volunteer repository", async () => {
      const repos = spy();
      const volunteers = platformWith({ volunteer: repos.volunteer }).volunteerManagement;

      unwrap(
        await volunteers.registerVolunteer.execute({
          name: "Anil Das",
          skills: [],
          languages: [],
          location: "Dhemaji",
        }),
      );

      expect(repos.calls).toContain("volunteer.save");
      expect(volunteers.volunteerRepository).toBe(repos.volunteer);
    });
  });

  describe("development planning", () => {
    it("builds a plan and reports progress on the in-memory default", async () => {
      const planning = platform().developmentPlanning;

      const plan = unwrap(await planning.createPlan.execute({ villageId: asVillage("village-1") }));
      const goal = unwrap(
        await planning.addGoal.execute({
          planId: asPlan(plan.planId),
          area: "education",
          description: "Reopen the primary school",
        }),
      );
      const milestone = unwrap(
        await planning.addMilestone.execute({
          planId: asPlan(plan.planId),
          goalId: goal.goalId,
          title: "Roof repaired",
          targetDate: "2026-09-01",
        }),
      );

      expect(unwrap(await planning.getProgress.execute({ planId: asPlan(plan.planId) })).overallPercent).toBe(0);

      unwrap(
        await planning.completeMilestone.execute({
          planId: asPlan(plan.planId),
          goalId: goal.goalId,
          milestoneId: milestone.milestoneId,
        }),
      );

      expect(unwrap(await planning.getProgress.execute({ planId: asPlan(plan.planId) })).overallPercent).toBe(100);
    });

    it("reads and writes through an injected plan repository", async () => {
      const repos = spy();
      const planning = platformWith({ plan: repos.plan }).developmentPlanning;

      unwrap(await planning.createPlan.execute({ villageId: asVillage("village-1") }));

      // findByVillage guards the one-plan-per-village rule, so both are expected.
      expect(repos.calls).toEqual(["plan.findByVillage", "plan.save"]);
      expect(planning.planRepository).toBe(repos.plan);
    });
  });

  describe("social media intelligence", () => {
    it("defaults the SignalExtractor port to the keyword adapter", () => {
      expect(platform().socialMediaIntelligence.signalExtractor).toBeInstanceOf(KeywordSignalExtractor);
    });

    it("ingests a raw report and raises alerts with no model configured", async () => {
      const smi = platform().socialMediaIntelligence;

      const ingested = unwrap(
        await smi.ingestRawReport.execute({
          rawText: "Relief distributed in Rampur village by Sewa Trust",
          source: "whatsapp_field_report",
        }),
      );
      const evaluated = unwrap(
        await smi.evaluateAlerts.execute({
          signalId: ingested.signalId,
          registryFacts: { villageKnown: true, hasActiveNgo: false, recentAidTypes: [] },
        }),
      );

      expect(evaluated.alerts.map((alert) => alert.type)).toEqual([
        "new_relief_activity",
        "no_ngo_assigned",
      ]);
    });

    it("uses an injected SignalExtractor instead of the keyword default", async () => {
      const extracted: Extracted = {
        villageName: "Majuli",
        activityType: "medical_camp",
        needs: ["medical"],
      };
      const stub: SignalExtractor = { extract: async () => ok(extracted) };

      const smi = platform({ signalExtractor: stub }).socialMediaIntelligence;
      expect(smi.signalExtractor).toBe(stub);

      const ingested = unwrap(
        await smi.ingestRawReport.execute({ rawText: "anything at all", source: "news" }),
      );
      const stored = await smi.signalRepository.findById(asSignal(ingested.signalId));

      // The keyword adapter would have found neither a village nor an activity
      // in "anything at all" — this is the injected extractor's output.
      expect(stored?.extracted.villageName).toBe("Majuli");
      expect(stored?.extracted.activityType).toBe("medical_camp");
    });

    it("writes signals and alerts through injected repositories", async () => {
      const repos = spy();
      const smi = platformWith({ signal: repos.signal, alert: repos.alert }).socialMediaIntelligence;

      unwrap(await smi.ingestRawReport.execute({ rawText: "Relief distributed", source: "news" }));
      await smi.alertRepository.listAll();

      expect(repos.calls).toEqual(["signal.save", "alert.listAll"]);
      expect(smi.signalRepository).toBe(repos.signal);
      expect(smi.alertRepository).toBe(repos.alert);
    });
  });

  it("leaves the four contexts on their in-memory defaults when nothing is injected", async () => {
    const repos = spy();
    // Inject ONE port; the other three contexts must be untouched by that.
    const wired = platformWith({ project: repos.project });

    const registered = unwrap(
      await wired.volunteerManagement.registerVolunteer.execute({
        name: "Anil Das",
        skills: [],
        languages: [],
        location: "Dhemaji",
      }),
    );

    expect(registered.volunteerId).toBeTruthy();
    expect(repos.calls.filter((call) => !call.startsWith("project."))).toEqual([]);
  });

  it("still returns a fully working platform from createPlatform() with no arguments", async () => {
    const bare = createPlatform();

    const sanctioned = unwrap(await bare.fundMonitoring.sanctionProject.execute(SANCTION_INPUT));
    expect(await bare.fundMonitoring.projectRepository.listAll()).toHaveLength(1);
    expect(sanctioned.projectId).toBeTruthy();
    expect(bare.socialMediaIntelligence.signalExtractor).toBeInstanceOf(KeywordSignalExtractor);
  });

  it("shares one event bus across old and new contexts", async () => {
    const wired = platform();
    const seen: string[] = [];
    wired.bus.subscribe("project.sanctioned.v1", async () => {
      seen.push("project.sanctioned.v1");
    });
    wired.bus.subscribe("volunteer.registered.v1", async () => {
      seen.push("volunteer.registered.v1");
    });

    unwrap(await wired.fundMonitoring.sanctionProject.execute(SANCTION_INPUT));
    unwrap(
      await wired.volunteerManagement.registerVolunteer.execute({
        name: "Anil Das",
        skills: [],
        languages: [],
        location: "Dhemaji",
      }),
    );

    expect(seen).toEqual(["project.sanctioned.v1", "volunteer.registered.v1"]);
  });
});
