/**
 * Boundary validation for Fund Monitoring commands.
 * Commands arrive from adapters as plain primitives; nothing untyped reaches the domain.
 */
import {
  type Brand,
  type Money,
  type ProjectId,
  type Result,
  type VillageId,
  err,
  isUuid,
  money,
  ok,
} from '../../../shared/index.js';

const parseId = <B extends string>(raw: string, code: string): Result<Brand<string, B>> =>
  isUuid(raw) ? ok(raw as Brand<string, B>) : err(code, `not a valid uuid: ${raw}`);

export const parseProjectId = (raw: string): Result<ProjectId> =>
  parseId<'ProjectId'>(raw, 'INVALID_PROJECT_ID');

export const parseVillageId = (raw: string): Result<VillageId> =>
  parseId<'VillageId'>(raw, 'INVALID_VILLAGE_ID');

export const parseAmount = (amountMinor: number, currency?: string): Result<Money> =>
  money(amountMinor, currency);
