import {
  asId,
  err,
  ok,
  type Clock,
  type EventPublisher,
  type IdGenerator,
  type NgoId,
  type Result,
} from '../../../shared/index.js';
import { ngoRegistered, ngoVerified } from '../domain/events.js';
import { registerNgo, verifyNgo } from '../domain/ngo.js';
import type { NgoRepository } from './ports.js';

export interface NgoWriteDeps {
  readonly ngos: NgoRepository;
  readonly events: EventPublisher;
  readonly clock: Clock;
}

export interface RegisterNgoDeps extends NgoWriteDeps {
  readonly ids: IdGenerator;
}

export interface RegisterNgoCommand {
  readonly name: string;
  readonly capacity: number;
}

export interface RegisterNgoResult {
  readonly ngoId: NgoId;
}

/** FR-NC-1: register an NGO with its declared capacity (unverified until reviewed). */
export const registerNgoUseCase =
  (deps: RegisterNgoDeps) =>
  async (command: RegisterNgoCommand): Promise<Result<RegisterNgoResult>> => {
    const created = registerNgo({
      id: asId<'NgoId'>(deps.ids.next()),
      name: command.name,
      capacity: command.capacity,
    });
    if (!created.ok) return created;

    await deps.ngos.save(created.value);
    await deps.events.publish([ngoRegistered(created.value, deps.clock.now())]);
    return ok({ ngoId: created.value.id });
  };

export interface VerifyNgoCommand {
  readonly ngoId: NgoId;
}

/** FR-NC-1: verify an NGO so it becomes eligible for village assignment. */
export const verifyNgoUseCase =
  (deps: NgoWriteDeps) =>
  async (command: VerifyNgoCommand): Promise<Result<void>> => {
    const existing = await deps.ngos.findById(command.ngoId);
    if (!existing) {
      return err('NGO_NOT_FOUND', `no NGO with id ${command.ngoId}`);
    }

    const verified = verifyNgo(existing);
    if (!verified.ok) return verified;

    await deps.ngos.save(verified.value);
    await deps.events.publish([ngoVerified(verified.value, deps.clock.now())]);
    return ok(undefined);
  };
