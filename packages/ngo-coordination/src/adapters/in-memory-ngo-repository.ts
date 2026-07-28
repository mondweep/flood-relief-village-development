import type { NgoId } from "@afrip/shared-kernel";
import type { Ngo } from "../domain/ngo.js";
import type { NgoRepository } from "../application/ports.js";

export class InMemoryNgoRepository implements NgoRepository {
  private readonly byId = new Map<string, Ngo>();

  async findById(id: NgoId): Promise<Ngo | undefined> {
    return this.byId.get(id);
  }

  async save(ngo: Ngo): Promise<void> {
    this.byId.set(ngo.id, ngo);
  }
}
