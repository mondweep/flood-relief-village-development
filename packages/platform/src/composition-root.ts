import {
  InMemoryEventBus,
  RandomIdGenerator,
  SequentialIdGenerator,
  type Clock,
  type EventPublisher,
  type IdGenerator,
} from "@afrip/shared-kernel";
import {
  CorrectVillageProfile,
  GetVillageProfile,
  InMemoryVillageRepository,
  ListVillagesBySeverity,
  MarkAsDemonstration,
  RecordDamageAssessment,
  RegisterVillage,
  UpdateSeverity,
  type VillageRepository,
} from "@afrip/village-registry";
import {
  AddCommitteeMember,
  AssignNgoToVillage,
  InMemoryAssignmentRepository,
  InMemoryNgoRepository,
  ListUnassignedVillages,
  RegisterNgo,
  type AssignmentRepository,
  type NgoRepository,
} from "@afrip/ngo-coordination";
import {
  DAMAGE_ASSESSED_EVENT,
  GetRecoveryIndex,
  GetScoreHistory,
  InMemoryRecoveryIndexRepository,
  RecommendActions,
  StaticWeightsProvider,
  UpsertDimensionScores,
  makeDamageAssessedHandler,
  type RecoveryIndexRepository,
} from "@afrip/recovery-intelligence";
import {
  InMemoryIssueRepository,
  ReportIssue,
  ResolveIssue,
  RouteIssue,
  StartProgress,
  VerifyResolution,
  type AssignmentLookup,
  type IssueRepository,
} from "@afrip/issue-tracking";
import {
  CompleteFollowUp,
  InMemoryBeneficiaryRepository,
  ListOverdueFollowUps,
  RecordAid,
  RegisterBeneficiary,
  ScheduleFollowUp,
  type BeneficiaryRepository,
} from "@afrip/beneficiary-registry";
import {
  CompleteProject,
  DetectAnomalies,
  InMemoryProjectRepository,
  RecordExpenditure,
  ReleaseFunds,
  SanctionProject,
  VerifyProject,
  type ProjectRepository,
} from "@afrip/fund-monitoring";
import {
  AssignVolunteer,
  InMemoryVolunteerRepository,
  Leaderboard,
  LogHours,
  RegisterVolunteer,
  SetAvailability,
  type VolunteerRepository,
} from "@afrip/volunteer-management";
import {
  AddGoal,
  AddMilestone,
  CompleteMilestone,
  CreatePlan,
  GetProgress,
  InMemoryPlanRepository,
  type PlanRepository,
} from "@afrip/development-planning";
import {
  EvaluateAlerts,
  InMemoryAlertRepository,
  InMemorySignalRepository,
  IngestRawReport,
  KeywordSignalExtractor,
  type AlertRepository,
  type SignalExtractor,
  type SignalRepository,
} from "@afrip/social-media-intelligence";

/**
 * The eleven outbound persistence ports the platform wires. Every entry is
 * optional: an omitted port falls back to this context's in-memory adapter, so
 * `createPlatform()` with no arguments stays a fully in-process platform.
 *
 * This is the seam that lets the API boot the same use cases against Supabase
 * (ADR 0004) without the composition root importing a single Supabase symbol —
 * it depends on the ports, never on a storage technology.
 *
 * NOTE: only six of these have a Supabase adapter today. The other five
 * (`project`, `volunteer`, `plan`, `signal`, `alert`) exist as ports with
 * in-memory adapters only, which is why `packages/api/src/persistence.ts`
 * discloses the memory-backed contexts on `GET /health` instead of letting
 * "PERSISTENCE=supabase" imply that every context is durable.
 */
export interface PlatformRepositories {
  village?: VillageRepository;
  ngo?: NgoRepository;
  assignment?: AssignmentRepository;
  recoveryIndex?: RecoveryIndexRepository;
  issue?: IssueRepository;
  beneficiary?: BeneficiaryRepository;
  project?: ProjectRepository;
  volunteer?: VolunteerRepository;
  plan?: PlanRepository;
  signal?: SignalRepository;
  alert?: AlertRepository;
}

export interface PlatformOverrides {
  /** Clock injected into every use case; defaults to the system clock. */
  clock?: Clock;
  /**
   * Factory producing one IdGenerator per id kind. Defaults to
   * `RandomIdGenerator` (UUID-based, safe across restarts and instances).
   * Tests override this with `SequentialIdGenerator` for deterministic ids —
   * which is the only place a resettable counter is safe.
   */
  idGenerator?: (prefix: string) => IdGenerator;
  /** Repository implementations per bounded context; each defaults to in-memory. */
  repositories?: PlatformRepositories;
  /**
   * The anti-corruption layer in front of AI extraction for Social Media
   * Intelligence. Defaults to `KeywordSignalExtractor`, the deterministic
   * keyword adapter, so the context works end to end with no LLM configured;
   * inject an LLM-backed adapter (or a stub, in tests) to replace it.
   */
  signalExtractor?: SignalExtractor;
  /**
   * The sink every use case publishes through (ADR 0010). Defaults to this
   * platform's own `bus`.
   *
   * A FUNCTION of the bus rather than a plain publisher, and that is the whole
   * reason it is shaped this way: the interesting implementation —
   * `ActorStampingPublisher` — *wraps* a publisher, and the most useful thing to
   * wrap is this platform's own bus, which does not exist until `createPlatform`
   * is running. Without the indirection a platform could never stamp the events
   * its own cross-context subscribers raise, which is precisely the case that
   * needs the `system` actor.
   *
   * Two callers matter, both in `packages/api/src/request-platform.ts`:
   *   - the long-lived platform stamps `system` onto its own bus, so a
   *     cross-context reaction (a recovery-index recalculation) or a scheduled
   *     sweep is attributed to the platform rather than to nobody;
   *   - a request-scoped platform IGNORES the bus it is handed and wraps the
   *     long-lived one instead, so its use cases publish the caller's actor into
   *     the bus the subscribers are already wired to.
   *
   * That second case redirects publication away from this platform's own `bus`,
   * leaving its subscriptions inert. Deliberate: re-subscribing on the shared bus
   * once per request would run every cross-context handler once per composed
   * platform, turning one damage assessment into N recovery recalculations.
   */
  eventPublisher?: (bus: InMemoryEventBus) => EventPublisher;
}

/**
 * The resolved shared ports of a platform: everything needed to compose a
 * SECOND platform over exactly the same state.
 *
 * This is what makes ADR 0010's per-request composition affordable. Spreading it
 * back into `createPlatform` re-wires the use cases — cheap object construction —
 * while the storage adapters, the clock and the id generators are the very same
 * instances. Without it, a per-request `createPlatform({})` would silently mint
 * fresh in-memory repositories (losing all data) and fresh id generators
 * (restarting every sequence at 1).
 */
export interface PlatformComposition {
  readonly clock: Clock;
  readonly idGenerator: (prefix: string) => IdGenerator;
  readonly repositories: Required<PlatformRepositories>;
  readonly signalExtractor: SignalExtractor;
}

export interface Platform {
  bus: InMemoryEventBus;
  /**
   * What the use cases actually publish through: `bus` unless
   * `overrides.eventPublisher` redirected it.
   */
  eventPublisher: EventPublisher;
  /** The shared ports this platform was built over — see `PlatformComposition`. */
  composition: PlatformComposition;
  villageRegistry: {
    registerVillage: RegisterVillage;
    recordDamageAssessment: RecordDamageAssessment;
    updateSeverity: UpdateSeverity;
    correctVillageProfile: CorrectVillageProfile;
    markAsDemonstration: MarkAsDemonstration;
    getVillageProfile: GetVillageProfile;
    listVillagesBySeverity: ListVillagesBySeverity;
  };
  ngoCoordination: {
    registerNgo: RegisterNgo;
    assignNgoToVillage: AssignNgoToVillage;
    addCommitteeMember: AddCommitteeMember;
    listUnassignedVillages: ListUnassignedVillages;
  };
  recoveryIntelligence: {
    upsertDimensionScores: UpsertDimensionScores;
    getRecoveryIndex: GetRecoveryIndex;
    getScoreHistory: GetScoreHistory;
    recommendActions: RecommendActions;
  };
  issueTracking: {
    reportIssue: ReportIssue;
    routeIssue: RouteIssue;
    startProgress: StartProgress;
    resolveIssue: ResolveIssue;
    verifyResolution: VerifyResolution;
  };
  beneficiaryRegistry: {
    registerBeneficiary: RegisterBeneficiary;
    recordAid: RecordAid;
    scheduleFollowUp: ScheduleFollowUp;
    completeFollowUp: CompleteFollowUp;
    listOverdueFollowUps: ListOverdueFollowUps;
  };
  fundMonitoring: {
    sanctionProject: SanctionProject;
    releaseFunds: ReleaseFunds;
    recordExpenditure: RecordExpenditure;
    completeProject: CompleteProject;
    verifyProject: VerifyProject;
    detectAnomalies: DetectAnomalies;
    /**
     * Read port for list queries. Fund Monitoring ships no list use case, and
     * the alternative — the API keeping its own event-sourced projection of
     * public money — would be a second, silently divergent source of truth for
     * the one figure that must never diverge. Exposed as the port, so a caller
     * still cannot see which storage technology is behind it.
     */
    projectRepository: ProjectRepository;
  };
  volunteerManagement: {
    registerVolunteer: RegisterVolunteer;
    setAvailability: SetAvailability;
    assignVolunteer: AssignVolunteer;
    logHours: LogHours;
    leaderboard: Leaderboard;
    /** Read port for `GET /volunteers`; the context ships no list use case. */
    volunteerRepository: VolunteerRepository;
  };
  developmentPlanning: {
    createPlan: CreatePlan;
    addGoal: AddGoal;
    addMilestone: AddMilestone;
    completeMilestone: CompleteMilestone;
    getProgress: GetProgress;
    /** Read port for the village -> plan lookup; the context ships no query use case for it. */
    planRepository: PlanRepository;
  };
  socialMediaIntelligence: {
    ingestRawReport: IngestRawReport;
    evaluateAlerts: EvaluateAlerts;
    /** The extractor actually in use — surfaced so the API can report which ACL is live. */
    signalExtractor: SignalExtractor;
    /** Read ports for `GET /signals` and `GET /alerts`; neither has a list use case. */
    signalRepository: SignalRepository;
    alertRepository: AlertRepository;
  };
}

const systemClock: Clock = { now: () => new Date() };

/**
 * Composition root: wires the nine bounded contexts together over the
 * in-process event bus (ADR 0005). Repository adapters default to in-memory but
 * can be supplied per context through `overrides.repositories`; cross-context
 * integration happens only through domain events and explicit port adapters.
 */
export function createPlatform(overrides: PlatformOverrides = {}): Platform {
  const clock = overrides.clock ?? systemClock;
  // RandomIdGenerator, not SequentialIdGenerator: the latter is a test fake that
  // counts in process memory, so it repeated ids after every scale-to-zero and
  // the Supabase upsert silently overwrote existing rows. Tests still inject
  // SequentialIdGenerator through this same override for determinism.
  const newIds = overrides.idGenerator ?? ((prefix: string) => new RandomIdGenerator(prefix));
  // Memoised per prefix, and exposed as `composition.idGenerator` so a platform
  // composed over this one gets the SAME generator instance per prefix rather
  // than a fresh one. Within a single platform this changes nothing — each
  // prefix is asked for exactly once below — but across ADR 0010's per-request
  // compositions it is what stops a sequence restarting at 1 on every request.
  const generators = new Map<string, IdGenerator>();
  const makeIds = (prefix: string): IdGenerator => {
    const existing = generators.get(prefix);
    if (existing !== undefined) return existing;
    const created = newIds(prefix);
    generators.set(prefix, created);
    return created;
  };
  const repositories = overrides.repositories ?? {};

  const bus = new InMemoryEventBus();
  // ADR 0010: use cases are given `publisher`, never `bus` directly, so a single
  // override can stamp every event this platform raises. Defaults to the bus, so
  // `createPlatform()` behaves exactly as it always has.
  const publisher: EventPublisher = overrides.eventPublisher?.(bus) ?? bus;

  // Village Registry
  const villageRepository = repositories.village ?? new InMemoryVillageRepository();
  const villageRegistry = {
    registerVillage: new RegisterVillage({
      repository: villageRepository,
      clock,
      idGenerator: makeIds("village"),
      eventPublisher: publisher,
    }),
    recordDamageAssessment: new RecordDamageAssessment({
      repository: villageRepository,
      clock,
      eventPublisher: publisher,
    }),
    updateSeverity: new UpdateSeverity({ repository: villageRepository, clock, eventPublisher: publisher }),
    correctVillageProfile: new CorrectVillageProfile({
      repository: villageRepository,
      clock,
      eventPublisher: publisher,
    }),
    markAsDemonstration: new MarkAsDemonstration({
      repository: villageRepository,
      clock,
      eventPublisher: publisher,
    }),
    getVillageProfile: new GetVillageProfile({ repository: villageRepository }),
    listVillagesBySeverity: new ListVillagesBySeverity({ repository: villageRepository }),
  };

  // NGO Coordination
  const ngoRepository = repositories.ngo ?? new InMemoryNgoRepository();
  const assignmentRepository = repositories.assignment ?? new InMemoryAssignmentRepository();
  const ngoCoordination = {
    registerNgo: new RegisterNgo({
      ngoRepository,
      idGenerator: makeIds("ngo"),
      clock,
      eventPublisher: publisher,
    }),
    assignNgoToVillage: new AssignNgoToVillage({
      ngoRepository,
      assignmentRepository,
      idGenerator: makeIds("assignment"),
      clock,
      eventPublisher: publisher,
    }),
    addCommitteeMember: new AddCommitteeMember({ assignmentRepository, clock, eventPublisher: publisher }),
    listUnassignedVillages: new ListUnassignedVillages({ assignmentRepository }),
  };

  // Recovery Intelligence
  const recoveryIndexRepository = repositories.recoveryIndex ?? new InMemoryRecoveryIndexRepository();
  const weightsProvider = new StaticWeightsProvider();
  const upsertDimensionScores = new UpsertDimensionScores({
    repository: recoveryIndexRepository,
    weightsProvider,
    clock,
    eventPublisher: publisher,
  });
  const recoveryIntelligence = {
    upsertDimensionScores,
    getRecoveryIndex: new GetRecoveryIndex({ repository: recoveryIndexRepository }),
    getScoreHistory: new GetScoreHistory({ repository: recoveryIndexRepository }),
    recommendActions: new RecommendActions(),
  };

  // Event-driven integration: damage assessments trigger recovery recalculation.
  bus.subscribe(DAMAGE_ASSESSED_EVENT, makeDamageAssessedHandler(upsertDimensionScores));

  // Issue Tracking — its AssignmentLookup port is adapted onto the
  // ngo-coordination assignment repository (composition-root adapter).
  const assignmentLookup: AssignmentLookup = {
    async findLeadNgo(villageId) {
      const assignment = await assignmentRepository.findActiveByVillage(villageId);
      if (!assignment) return null;
      const ngo = await ngoRepository.findById(assignment.ngoId);
      if (!ngo) return null;
      return { ngoId: ngo.id, name: ngo.name };
    },
  };
  const issueRepository = repositories.issue ?? new InMemoryIssueRepository();
  const issueTracking = {
    reportIssue: new ReportIssue({
      repository: issueRepository,
      clock,
      idGenerator: makeIds("issue"),
      eventPublisher: publisher,
    }),
    routeIssue: new RouteIssue({ repository: issueRepository, assignmentLookup, clock, eventPublisher: publisher }),
    startProgress: new StartProgress({ repository: issueRepository, clock, eventPublisher: publisher }),
    resolveIssue: new ResolveIssue({ repository: issueRepository, clock, eventPublisher: publisher }),
    verifyResolution: new VerifyResolution({ repository: issueRepository, clock, eventPublisher: publisher }),
  };

  // Beneficiary Registry
  const beneficiaryRepository = repositories.beneficiary ?? new InMemoryBeneficiaryRepository();
  const beneficiaryRegistry = {
    registerBeneficiary: new RegisterBeneficiary({
      repository: beneficiaryRepository,
      clock,
      idGenerator: makeIds("beneficiary"),
      eventPublisher: publisher,
    }),
    recordAid: new RecordAid({ repository: beneficiaryRepository, clock, eventPublisher: publisher }),
    scheduleFollowUp: new ScheduleFollowUp({
      repository: beneficiaryRepository,
      clock,
      idGenerator: makeIds("follow-up"),
      eventPublisher: publisher,
    }),
    completeFollowUp: new CompleteFollowUp({ repository: beneficiaryRepository, clock, eventPublisher: publisher }),
    listOverdueFollowUps: new ListOverdueFollowUps({ repository: beneficiaryRepository, clock }),
  };

  // Fund Monitoring
  const projectRepository = repositories.project ?? new InMemoryProjectRepository();
  const fundMonitoring = {
    sanctionProject: new SanctionProject({
      repository: projectRepository,
      clock,
      idGenerator: makeIds("project"),
      eventPublisher: publisher,
    }),
    releaseFunds: new ReleaseFunds({ repository: projectRepository, clock, eventPublisher: publisher }),
    recordExpenditure: new RecordExpenditure({ repository: projectRepository, clock, eventPublisher: publisher }),
    completeProject: new CompleteProject({ repository: projectRepository, clock, eventPublisher: publisher }),
    verifyProject: new VerifyProject({ repository: projectRepository, clock, eventPublisher: publisher }),
    detectAnomalies: new DetectAnomalies({ repository: projectRepository, clock, eventPublisher: publisher }),
    projectRepository,
  };

  // Volunteer Management
  const volunteerRepository = repositories.volunteer ?? new InMemoryVolunteerRepository();
  const volunteerManagement = {
    registerVolunteer: new RegisterVolunteer({
      repository: volunteerRepository,
      clock,
      idGenerator: makeIds("volunteer"),
      eventPublisher: publisher,
    }),
    setAvailability: new SetAvailability({ repository: volunteerRepository, clock, eventPublisher: publisher }),
    assignVolunteer: new AssignVolunteer({
      repository: volunteerRepository,
      clock,
      idGenerator: makeIds("volunteer-assignment"),
      eventPublisher: publisher,
    }),
    logHours: new LogHours({ repository: volunteerRepository, clock, eventPublisher: publisher }),
    leaderboard: new Leaderboard({ repository: volunteerRepository }),
    volunteerRepository,
  };

  // Development Planning
  const planRepository = repositories.plan ?? new InMemoryPlanRepository();
  const developmentPlanning = {
    createPlan: new CreatePlan({
      repository: planRepository,
      clock,
      idGenerator: makeIds("plan"),
      eventPublisher: publisher,
    }),
    addGoal: new AddGoal({
      repository: planRepository,
      clock,
      idGenerator: makeIds("goal"),
      eventPublisher: publisher,
    }),
    addMilestone: new AddMilestone({
      repository: planRepository,
      clock,
      idGenerator: makeIds("milestone"),
      eventPublisher: publisher,
    }),
    completeMilestone: new CompleteMilestone({ repository: planRepository, clock, eventPublisher: publisher }),
    getProgress: new GetProgress({ repository: planRepository }),
    planRepository,
  };

  // Social Media Intelligence — the SignalExtractor port defaults to the
  // deterministic keyword adapter so the context needs no LLM to run.
  const signalRepository = repositories.signal ?? new InMemorySignalRepository();
  const alertRepository = repositories.alert ?? new InMemoryAlertRepository();
  const signalExtractor = overrides.signalExtractor ?? new KeywordSignalExtractor();
  const socialMediaIntelligence = {
    ingestRawReport: new IngestRawReport({
      signalRepository,
      extractor: signalExtractor,
      clock,
      idGenerator: makeIds("signal"),
      eventPublisher: publisher,
    }),
    evaluateAlerts: new EvaluateAlerts({
      signalRepository,
      alertRepository,
      clock,
      idGenerator: makeIds("alert"),
      eventPublisher: publisher,
    }),
    signalExtractor,
    signalRepository,
    alertRepository,
  };

  return {
    bus,
    eventPublisher: publisher,
    // The resolved ports, handed back so a caller can compose an equivalent
    // platform over the same state without knowing which adapters were chosen.
    composition: {
      clock,
      idGenerator: makeIds,
      repositories: {
        village: villageRepository,
        ngo: ngoRepository,
        assignment: assignmentRepository,
        recoveryIndex: recoveryIndexRepository,
        issue: issueRepository,
        beneficiary: beneficiaryRepository,
        project: projectRepository,
        volunteer: volunteerRepository,
        plan: planRepository,
        signal: signalRepository,
        alert: alertRepository,
      },
      signalExtractor,
    },
    villageRegistry,
    ngoCoordination,
    recoveryIntelligence,
    issueTracking,
    beneficiaryRegistry,
    fundMonitoring,
    volunteerManagement,
    developmentPlanning,
    socialMediaIntelligence,
  };
}
