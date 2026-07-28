import { err, ok, type Result, type VolunteerId } from "@afrip/shared-kernel";

export type Availability = "available" | "unavailable";

export interface Assignment {
  readonly id: string;
  readonly villageId: string;
  readonly task: string;
  readonly assignedAt: string; // ISO
  readonly hours: number;
}

export interface VolunteerCreateProps {
  id: VolunteerId;
  name: string;
  skills: string[];
  languages: string[];
  location: string;
  availability?: Availability;
}

function validateVolunteerProps(props: VolunteerCreateProps): string | null {
  if (props.name.trim().length === 0) return "name must not be empty";
  if (props.location.trim().length === 0) return "location must not be empty";
  const availability = props.availability ?? "available";
  if (!["available", "unavailable"].includes(availability)) {
    return "availability must be 'available' or 'unavailable'";
  }
  return null;
}

export class Volunteer {
  readonly id: VolunteerId;
  name: string;
  skills: string[];
  languages: string[];
  location: string;
  availability: Availability;
  private readonly _assignments: Assignment[];

  private constructor(props: VolunteerCreateProps, assignments: Assignment[]) {
    this.id = props.id;
    this.name = props.name;
    this.skills = [...props.skills];
    this.languages = [...props.languages];
    this.location = props.location;
    this.availability = props.availability ?? "available";
    this._assignments = assignments;
  }

  static create(props: VolunteerCreateProps): Result<Volunteer> {
    const error = validateVolunteerProps(props);
    if (error) return err(error);
    return ok(new Volunteer(props, []));
  }

  /** Deep copies — mutating the returned array or its elements does not affect the aggregate. */
  get assignments(): readonly Assignment[] {
    return this._assignments.map((a) => ({ ...a }));
  }

  getTotalHours(): number {
    return this._assignments.reduce((total, a) => total + a.hours, 0);
  }

  /** Assigns the volunteer, enforcing the availability rule inside the aggregate. */
  assignTo(assignment: Assignment): Result<void> {
    if (!this.canBeAssigned()) {
      return err("volunteer is not available");
    }
    this._assignments.push({ ...assignment });
    return ok(undefined);
  }

  setAvailability(newAvailability: Availability): Result<{ previous: Availability }> {
    if (!["available", "unavailable"].includes(newAvailability)) {
      return err("availability must be 'available' or 'unavailable'");
    }
    const previous = this.availability;
    this.availability = newAvailability;
    return ok({ previous });
  }

  canBeAssigned(): boolean {
    return this.availability === "available";
  }

  /** Copy — mutating the returned assignment does not affect the aggregate. */
  findAssignmentById(assignmentId: string): Assignment | null {
    const assignment = this._assignments.find((a) => a.id === assignmentId);
    return assignment ? { ...assignment } : null;
  }

  logHours(assignmentId: string, hours: number): Result<void> {
    if (hours <= 0) return err("hours must be greater than 0");
    const index = this._assignments.findIndex((a) => a.id === assignmentId);
    if (index === -1) return err("assignment not found");
    const assignment = this._assignments[index]!;
    this._assignments[index] = { ...assignment, hours: assignment.hours + hours };
    return ok(undefined);
  }
}
