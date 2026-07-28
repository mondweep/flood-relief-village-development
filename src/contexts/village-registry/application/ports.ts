import type { VillageId } from '../../../shared/index.js';
import type { Village } from '../domain/village.js';

/** Driven port (PRD §5 BC-1): persistence for the Village aggregate. */
export interface VillageRepository {
  findById(id: VillageId): Promise<Village | null>;
  save(village: Village): Promise<void>;
}
