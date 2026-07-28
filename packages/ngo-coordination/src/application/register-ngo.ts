import { err, ngoId, ok, type Clock, type EventPublisher, type IdGenerator, type Result } from "@afrip/shared-kernel";
import { Ngo } from "../domain/ngo.js";
import type { NgoRepository } from "./ports.js";

export interface RegisterNgoDeps {
  ngoRepository: NgoRepository;
  idGenerator: IdGenerator;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export interface RegisterNgoInput {
  name: string;
  focusAreas: string[];
  capacity: number;
}

export interface RegisterNgoOutput {
  ngoId: string;
}

export class RegisterNgo {
  constructor(private readonly deps: RegisterNgoDeps) {}

  async execute(input: RegisterNgoInput): Promise<Result<RegisterNgoOutput>> {
    const idResult = ngoId(this.deps.idGenerator.next());
    if (!idResult.ok) return err(idResult.error);

    const ngoResult = Ngo.create({
      id: idResult.value,
      name: input.name,
      focusAreas: input.focusAreas,
      capacity: input.capacity,
    });
    if (!ngoResult.ok) return err(ngoResult.error);
    const ngo = ngoResult.value;

    await this.deps.ngoRepository.save(ngo);

    await this.deps.eventPublisher.publish([
      {
        name: "ngo.registered.v1",
        occurredAt: this.deps.clock.now().toISOString(),
        payload: {
          ngoId: ngo.id,
          name: ngo.name,
          focusAreas: [...ngo.focusAreas],
          capacity: ngo.capacity,
        },
      },
    ]);

    return ok({ ngoId: ngo.id });
  }
}
