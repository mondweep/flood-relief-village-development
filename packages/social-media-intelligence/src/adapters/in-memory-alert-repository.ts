import type { SmartAlert } from "../domain/smart-alert.js";
import type { AlertRepository } from "../application/ports.js";

/** In-memory fake adapter for AlertRepository — used in tests and local runs. */
export class InMemoryAlertRepository implements AlertRepository {
  private readonly alerts = new Map<string, SmartAlert>();

  async save(alert: SmartAlert): Promise<void> {
    this.alerts.set(alert.id, alert);
  }

  async listAll(): Promise<SmartAlert[]> {
    return Array.from(this.alerts.values());
  }
}
