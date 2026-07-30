import {
  err,
  ok,
  villageId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type Result,
} from "@afrip/shared-kernel";
import type { VillageRepository } from "./ports.js";

/**
 * "This village is here to be looked at, not to be believed."
 *
 * A SEPARATE OPERATION, never a field on registration. `RegisterVillage` has no
 * way to produce a flagged record — `VillageCreateProps` carries no such field
 * and `Village.markAsDemonstration` is the only writer — so the flag can only be
 * applied by someone who came here specifically to apply it. The alternative,
 * an `isDemonstration` on the registration payload, would let a real village
 * arrive flagged through a typo, a copied curl command or a stale form, and the
 * result of that mistake is a village silently absent from every count the
 * dashboard publishes. An absence is the hardest error to notice; see
 * `docs/incidents/2026-07-28-id-collision-data-loss.md`.
 *
 * There is no counterpart use case that clears the flag, and there is not meant
 * to be. See `Village.markAsDemonstration` for the argument.
 */

export interface MarkAsDemonstrationInput {
  villageId: string;
  /**
   * Required, free text. Same rule as `CorrectVillageProfile`: a record being
   * removed from the platform's real reporting is exactly the kind of change
   * that must not be unexplained six months later. "Seeded during the 2026-07-28
   * incident" is the reason this operation was built for.
   */
  reason: string;
}

export interface MarkAsDemonstrationOutput {
  villageId: string;
  /** Always true on success — the flag is one-way. */
  isDemonstration: boolean;
  /**
   * True when the village already carried the flag, so a caller re-running a
   * marking script can tell a no-op from a change. The operation succeeds either
   * way: it asserts a state, not a transition.
   */
  alreadyMarked: boolean;
  reason: string;
}

export interface MarkAsDemonstrationDeps {
  repository: VillageRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class MarkAsDemonstration {
  constructor(private readonly deps: MarkAsDemonstrationDeps) {}

  async execute(input: MarkAsDemonstrationInput): Promise<Result<MarkAsDemonstrationOutput>> {
    const idResult = villageId(input.villageId);
    if (!idResult.ok) return err(idResult.error);

    const reason = input.reason.trim();
    if (reason.length === 0) return err("reason must not be empty");

    const village = await this.deps.repository.findById(idResult.value);
    if (!village) return err(`Village not found: ${input.villageId}`);

    const alreadyMarked = village.isDemonstration;

    // Idempotent, and quiet about it: re-marking neither writes nor publishes.
    // An audit log that shows the same village being declared demonstration data
    // nine times because a script was re-run tells the reader nothing they did
    // not already know, and makes the one entry that mattered harder to find.
    if (!alreadyMarked) {
      village.markAsDemonstration();
      await this.deps.repository.save(village);

      const payload: Record<string, unknown> = {
        villageId: village.id,
        name: village.name,
        reason,
      };
      const event: DomainEvent = {
        name: "village.marked-as-demonstration.v1",
        occurredAt: this.deps.clock.now().toISOString(),
        payload,
      };
      await this.deps.eventPublisher.publish([event]);
    }

    return ok({
      villageId: village.id,
      isDemonstration: village.isDemonstration,
      alreadyMarked,
      reason,
    });
  }
}
