import {
  InMemoryEventBus,
  RandomIdGenerator,
  SequentialIdGenerator,
  type Clock,
  type IdGenerator,
} from "@afrip/shared-kernel";
import {
  CorrectVillageProfile,
  GetVillageProfile,
  InMemoryVillageRepository,
  ListVillagesBySeverity,
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
}

export interface Platform {
  bus: InMemoryEventBus;
  villageRegistry: {
    registerVillage: RegisterVillage;
    recordDamageAssessment: RecordDamageAssessment;
    updateSeverity: UpdateSeverity;
    correctVillageProfile: CorrectVillageProfile;
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
  const makeIds = overrides.idGenerator ?? ((prefix: string) => new RandomIdGenerator(prefix));
  const repositories = overrides.repositories ?? {};

  const bus = new InMemoryEventBus();

  // Village Registry
  const villageRepository = repositories.village ?? new InMemoryVillageRepository();
  const villageRegistry = {
    registerVillage: new RegisterVillage({
      repository: villageRepository,
      clock,
      idGenerator: makeIds("village"),
      eventPublisher: bus,
    }),
    recordDamageAssessment: new RecordDamageAssessment({
      repository: villageRepository,
      clock,
      eventPublisher: bus,
    }),
    updateSeverity: new UpdateSeverity({ repository: villageRepository, clock, eventPublisher: bus }),
    correctVillageProfile: new CorrectVillageProfile({
      repository: villageRepository,
      clock,
      eventPublisher: bus,
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
      eventPublisher: bus,
    }),
    assignNgoToVillage: new AssignNgoToVillage({
      ngoRepository,
      assignmentRepository,
      idGenerator: makeIds("assignment"),
      clock,
      eventPublisher: bus,
    }),
    addCommitteeMember: new AddCommitteeMember({ assignmentRepository, clock, eventPublisher: bus }),
    listUnassignedVillages: new ListUnassignedVillages({ assignmentRepository }),
  };

  // Recovery Intelligence
  const recoveryIndexRepository = repositories.recoveryIndex ?? new InMemoryRecoveryIndexRepository();
  const weightsProvider = new StaticWeightsProvider();
  const upsertDimensionScores = new UpsertDimensionScores({
    repository: recoveryIndexRepository,
    weightsProvider,
    clock,
    eventPublisher: bus,
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
      eventPublisher: bus,
    }),
    routeIssue: new RouteIssue({ repository: issueRepository, assignmentLookup, clock, eventPublisher: bus }),
    startProgress: new StartProgress({ repository: issueRepository, clock, eventPublisher: bus }),
    resolveIssue: new ResolveIssue({ repository: issueRepository, clock, eventPublisher: bus }),
    verifyResolution: new VerifyResolution({ repository: issueRepository, clock, eventPublisher: bus }),
  };

  // Beneficiary Registry
  const beneficiaryRepository = repositories.beneficiary ?? new InMemoryBeneficiaryRepository();
  const beneficiaryRegistry = {
    registerBeneficiary: new RegisterBeneficiary({
      repository: beneficiaryRepository,
      clock,
      idGenerator: makeIds("beneficiary"),
      eventPublisher: bus,
    }),
    recordAid: new RecordAid({ repository: beneficiaryRepository, clock, eventPublisher: bus }),
    scheduleFollowUp: new ScheduleFollowUp({
      repository: beneficiaryRepository,
      clock,
      idGenerator: makeIds("follow-up"),
      eventPublisher: bus,
    }),
    completeFollowUp: new CompleteFollowUp({ repository: beneficiaryRepository, clock, eventPublisher: bus }),
    listOverdueFollowUps: new ListOverdueFollowUps({ repository: beneficiaryRepository, clock }),
  };

  // Fund Monitoring
  const projectRepository = repositories.project ?? new InMemoryProjectRepository();
  const fundMonitoring = {
    sanctionProject: new SanctionProject({
      repository: projectRepository,
      clock,
      idGenerator: makeIds("project"),
      eventPublisher: bus,
    }),
    releaseFunds: new ReleaseFunds({ repository: projectRepository, clock, eventPublisher: bus }),
    recordExpenditure: new RecordExpenditure({ repository: projectRepository, clock, eventPublisher: bus }),
    completeProject: new CompleteProject({ repository: projectRepository, clock, eventPublisher: bus }),
    verifyProject: new VerifyProject({ repository: projectRepository, clock, eventPublisher: bus }),
    detectAnomalies: new DetectAnomalies({ repository: projectRepository, clock, eventPublisher: bus }),
    projectRepository,
  };

  // Volunteer Management
  const volunteerRepository = repositories.volunteer ?? new InMemoryVolunteerRepository();
  const volunteerManagement = {
    registerVolunteer: new RegisterVolunteer({
      repository: volunteerRepository,
      clock,
      idGenerator: makeIds("volunteer"),
      eventPublisher: bus,
    }),
    setAvailability: new SetAvailability({ repository: volunteerRepository, clock, eventPublisher: bus }),
    assignVolunteer: new AssignVolunteer({
      repository: volunteerRepository,
      clock,
      idGenerator: makeIds("volunteer-assignment"),
      eventPublisher: bus,
    }),
    logHours: new LogHours({ repository: volunteerRepository, clock, eventPublisher: bus }),
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
      eventPublisher: bus,
    }),
    addGoal: new AddGoal({
      repository: planRepository,
      clock,
      idGenerator: makeIds("goal"),
      eventPublisher: bus,
    }),
    addMilestone: new AddMilestone({
      repository: planRepository,
      clock,
      idGenerator: makeIds("milestone"),
      eventPublisher: bus,
    }),
    completeMilestone: new CompleteMilestone({ repository: planRepository, clock, eventPublisher: bus }),
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
      eventPublisher: bus,
    }),
    evaluateAlerts: new EvaluateAlerts({
      signalRepository,
      alertRepository,
      clock,
      idGenerator: makeIds("alert"),
      eventPublisher: bus,
    }),
    signalExtractor,
    signalRepository,
    alertRepository,
  };

  return {
    bus,
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
