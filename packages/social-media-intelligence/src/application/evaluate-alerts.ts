import {
  alertId,
  err,
  ok,
  signalId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type IdGenerator,
  type Result,
} from "@afrip/shared-kernel";
import { evaluateAlertRules, type RegistryFacts } from "../domain/alert-rules.js";
import { SmartAlert, type AlertType } from "../domain/smart-alert.js";
import type { AlertRepository, SignalRepository } from "./ports.js";

export type { RegistryFacts } from "../domain/alert-rules.js";

export interface EvaluateAlertsInput {
  signalId: string;
  registryFacts: RegistryFacts;
}

export interface RaisedAlert {
  alertId: string;
  type: AlertType;
}

export interface EvaluateAlertsOutput {
  alerts: RaisedAlert[];
}

export interface EvaluateAlertsDeps {
  signalRepository: SignalRepository;
  alertRepository: AlertRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  eventPublisher: EventPublisher;
}

export class EvaluateAlerts {
  constructor(private readonly deps: EvaluateAlertsDeps) {}

  async execute(input: EvaluateAlertsInput): Promise<Result<EvaluateAlertsOutput>> {
    const signalIdResult = signalId(input.signalId);
    if (!signalIdResult.ok) return err(signalIdResult.error);

    const signal = await this.deps.signalRepository.findById(signalIdResult.value);
    if (!signal) return err(`signal not found: ${input.signalId}`);

    const specs = evaluateAlertRules(signal, input.registryFacts);
    const raisedAt = this.deps.clock.now().toISOString();

    // Phase 1: build and validate every alert before persisting anything, so an
    // id/create failure mid-batch leaves no partially saved alerts without events.
    const alerts: SmartAlert[] = [];
    for (const spec of specs) {
      const idResult = alertId(this.deps.idGenerator.next());
      if (!idResult.ok) return err(idResult.error);

      const alertResult = SmartAlert.create({
        id: idResult.value,
        type: spec.type,
        signalId: signal.id,
        villageName: signal.extracted.villageName,
        details: spec.details,
        raisedAt,
      });
      if (!alertResult.ok) return err(alertResult.error);
      alerts.push(alertResult.value);
    }

    // Phase 2: all alerts are valid — save them and publish their events.
    const raised: RaisedAlert[] = [];
    const events: DomainEvent[] = [];
    for (const alert of alerts) {
      await this.deps.alertRepository.save(alert);
      events.push({
        name: "alert.raised.v1",
        occurredAt: raisedAt,
        payload: {
          alertId: alert.id,
          alertType: alert.type,
          signalId: alert.signalId,
          villageName: alert.villageName ?? null,
          details: alert.details,
        },
      });
      raised.push({ alertId: alert.id, type: alert.type });
    }

    if (events.length > 0) {
      await this.deps.eventPublisher.publish(events);
    }

    return ok({ alerts: raised });
  }
}
