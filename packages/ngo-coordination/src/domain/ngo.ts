import { err, ok, type NgoId, type Result } from "@afrip/shared-kernel";

export interface NgoProps {
  id: NgoId;
  name: string;
  focusAreas: string[];
  capacity: number;
}

/** Ngo aggregate: a registered relief NGO with a fixed capacity for concurrent village assignments. */
export class Ngo {
  readonly id: NgoId;
  readonly name: string;
  readonly focusAreas: readonly string[];
  readonly capacity: number;

  private constructor(props: NgoProps) {
    this.id = props.id;
    this.name = props.name;
    this.focusAreas = [...props.focusAreas];
    this.capacity = props.capacity;
  }

  static create(props: NgoProps): Result<Ngo> {
    if (props.name.trim().length === 0) return err("Ngo name must be a non-empty string");
    if (!Number.isInteger(props.capacity) || props.capacity < 1) {
      return err("Ngo capacity must be an integer >= 1");
    }
    return ok(new Ngo(props));
  }
}
