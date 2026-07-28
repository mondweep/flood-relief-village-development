import type { SignalId } from "@afrip/shared-kernel";
import type { Signal } from "../domain/signal.js";
import type { SignalRepository } from "../application/ports.js";

/** In-memory fake adapter for SignalRepository — used in tests and local runs. */
export class InMemorySignalRepository implements SignalRepository {
  private readonly signals = new Map<string, Signal>();

  async findById(id: SignalId): Promise<Signal | null> {
    return this.signals.get(id) ?? null;
  }

  async save(signal: Signal): Promise<void> {
    this.signals.set(signal.id, signal);
  }

  async listAll(): Promise<Signal[]> {
    return Array.from(this.signals.values());
  }
}
