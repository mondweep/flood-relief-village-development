export type { ActivityType, Extracted, SignalCreateProps, Source } from "./domain/signal.js";
export { Signal, isActivityType, isSource } from "./domain/signal.js";

export type { AlertType, SmartAlertCreateProps } from "./domain/smart-alert.js";
export { SmartAlert, isAlertType } from "./domain/smart-alert.js";

export { evaluateAlertRules, type AlertSpec, type RegistryFacts } from "./domain/alert-rules.js";

export type { AlertRepository, SignalExtractor, SignalRepository } from "./application/ports.js";

export {
  IngestRawReport,
  type IngestRawReportDeps,
  type IngestRawReportInput,
  type IngestRawReportOutput,
} from "./application/ingest-raw-report.js";

export {
  EvaluateAlerts,
  type EvaluateAlertsDeps,
  type EvaluateAlertsInput,
  type EvaluateAlertsOutput,
  type RaisedAlert,
} from "./application/evaluate-alerts.js";

export { InMemorySignalRepository } from "./adapters/in-memory-signal-repository.js";
export { InMemoryAlertRepository } from "./adapters/in-memory-alert-repository.js";
export { KeywordSignalExtractor } from "./adapters/keyword-signal-extractor.js";
