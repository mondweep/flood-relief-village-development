import type { DomainEvent, InMemoryEventBus } from "@afrip/shared-kernel";

export interface BeneficiaryDirectoryEntry {
  readonly beneficiaryId: string;
  readonly villageId: string;
  readonly category: string;
  readonly aidDeliveries: number;
  readonly lastAidAt: string | null;
  readonly duplicateFlags: number;
}

function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

/**
 * Read model backing `GET /villages/:id/beneficiaries`.
 *
 * The Beneficiary Registry exposes no list-by-village query use case, and the API
 * must not reach around it into a repository. So we project the context's
 * published-language events instead (ADR 0005). A useful side effect: the events
 * carry identifiers and categories but no names, so this projection is PII-free
 * by construction and cannot leak a beneficiary's identity.
 *
 * TODO(persistence): this projection lives in process memory and is rebuilt on
 * every boot. When the Supabase adapters land it should be replaced by either a
 * real list-by-village query on the context or a persisted projection table.
 */
export class BeneficiaryDirectory {
  private readonly entries = new Map<string, BeneficiaryDirectoryEntry>();

  /** Subscribes to the platform bus. Construct exactly one per platform instance. */
  constructor(bus: InMemoryEventBus) {
    bus.subscribe("beneficiary.registered.v1", async (event) => this.onRegistered(event));
    bus.subscribe("beneficiary.aid-recorded.v1", async (event) => this.onAidRecorded(event));
    bus.subscribe("beneficiary.duplicate-aid-flagged.v1", async (event) => this.onDuplicateFlagged(event));
  }

  listByVillage(villageId: string): BeneficiaryDirectoryEntry[] {
    return [...this.entries.values()].filter((entry) => entry.villageId === villageId);
  }

  private onRegistered(event: DomainEvent): void {
    const beneficiaryId = text(event.payload, "beneficiaryId");
    const villageId = text(event.payload, "villageId");
    if (beneficiaryId === null || villageId === null) return;
    this.entries.set(beneficiaryId, {
      beneficiaryId,
      villageId,
      category: text(event.payload, "category") ?? "unknown",
      aidDeliveries: 0,
      lastAidAt: null,
      duplicateFlags: 0,
    });
  }

  private onAidRecorded(event: DomainEvent): void {
    const existing = this.find(event);
    if (!existing) return;
    this.entries.set(existing.beneficiaryId, {
      ...existing,
      aidDeliveries: existing.aidDeliveries + 1,
      lastAidAt: text(event.payload, "deliveredAt") ?? existing.lastAidAt,
    });
  }

  private onDuplicateFlagged(event: DomainEvent): void {
    const existing = this.find(event);
    if (!existing) return;
    this.entries.set(existing.beneficiaryId, {
      ...existing,
      duplicateFlags: existing.duplicateFlags + 1,
    });
  }

  private find(event: DomainEvent): BeneficiaryDirectoryEntry | undefined {
    const beneficiaryId = text(event.payload, "beneficiaryId");
    return beneficiaryId === null ? undefined : this.entries.get(beneficiaryId);
  }
}
