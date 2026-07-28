import {
  InMemoryEventBus,
  SequentialIdGenerator,
  type Clock,
  type IdGenerator,
} from "@afrip/shared-kernel";
import {
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

/**
 * The six outbound persistence ports the platform wires. Every entry is
 * optional: an omitted port falls back to this context's in-memory adapter, so
 * `createPlatform()` with no arguments stays a fully in-process platform.
 *
 * This is the seam that lets the API boot the same use cases against Supabase
 * (ADR 0004) without the composition root importing a single Supabase symbol —
 * it depends on the ports, never on a storage technology.
 */
export interface PlatformRepositories {
  village?: VillageRepository;
  ngo?: NgoRepository;
  assignment?: AssignmentRepository;
  recoveryIndex?: RecoveryIndexRepository;
  issue?: IssueRepository;
  beneficiary?: BeneficiaryRepository;
}

export interface PlatformOverrides {
  /** Clock injected into every use case; defaults to the system clock. */
  clock?: Clock;
  /** Factory producing one IdGenerator per id kind; defaults to SequentialIdGenerator. */
  idGenerator?: (prefix: string) => IdGenerator;
  /** Repository implementations per bounded context; each defaults to in-memory. */
  repositories?: PlatformRepositories;
}

export interface Platform {
  bus: InMemoryEventBus;
  villageRegistry: {
    registerVillage: RegisterVillage;
    recordDamageAssessment: RecordDamageAssessment;
    updateSeverity: UpdateSeverity;
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
}

const systemClock: Clock = { now: () => new Date() };

/**
 * Composition root: wires the five bounded contexts together over the
 * in-process event bus (ADR 0005). Repository adapters default to in-memory but
 * can be supplied per context through `overrides.repositories`; cross-context
 * integration happens only through domain events and explicit port adapters.
 */
export function createPlatform(overrides: PlatformOverrides = {}): Platform {
  const clock = overrides.clock ?? systemClock;
  const makeIds = overrides.idGenerator ?? ((prefix: string) => new SequentialIdGenerator(prefix));
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

  return { bus, villageRegistry, ngoCoordination, recoveryIntelligence, issueTracking, beneficiaryRegistry };
}
