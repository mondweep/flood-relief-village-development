import type { Result, SignalId } from "@afrip/shared-kernel";
import type { Extracted, Signal, Source } from "../domain/signal.js";
import type { SmartAlert } from "../domain/smart-alert.js";

/** Outbound port: persistence for the Signal aggregate. */
export interface SignalRepository {
  findById(id: SignalId): Promise<Signal | null>;
  save(signal: Signal): Promise<void>;
  listAll(): Promise<Signal[]>;
}

/** Outbound port: persistence for SmartAlerts. */
export interface AlertRepository {
  save(alert: SmartAlert): Promise<void>;
  listAll(): Promise<SmartAlert[]>;
}

/**
 * Anti-corruption layer around AI extraction. The application core only ever
 * sees this port — the concrete adapter may be an LLM, a keyword heuristic, or
 * a test mock.
 */
export interface SignalExtractor {
  extract(rawText: string, source: Source): Promise<Result<Extracted>>;
}
