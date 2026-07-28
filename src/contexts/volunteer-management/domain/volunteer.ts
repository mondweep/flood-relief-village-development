import type { VolunteerId, VillageId } from '../../../shared/index.js';

export type Availability = 'weekdays' | 'weekends' | 'full_time';

export interface ActiveAssignment {
  readonly villageId: VillageId;
  readonly role: string;
  readonly since: Date;
}

export class Volunteer {
  private constructor(
    readonly id: VolunteerId,
    readonly name: string,
    readonly contact: string,
    readonly skills: readonly string[],
    readonly languages: readonly string[],
    readonly location: string,
    readonly availability: Availability,
    readonly activeAssignment: ActiveAssignment | null,
    readonly totalHours: number,
    readonly certificates: readonly string[],
  ) {}

  static create(
    id: VolunteerId,
    name: string,
    contact: string,
    skills: readonly string[],
    languages: readonly string[],
    location: string,
    availability: Availability,
  ): Volunteer {
    return new Volunteer(
      id,
      name,
      contact,
      skills,
      languages,
      location,
      availability,
      null,
      0,
      [],
    );
  }

  static hydrate(
    id: VolunteerId,
    name: string,
    contact: string,
    skills: readonly string[],
    languages: readonly string[],
    location: string,
    availability: Availability,
    activeAssignment: ActiveAssignment | null,
    totalHours: number,
    certificates: readonly string[],
  ): Volunteer {
    return new Volunteer(id, name, contact, skills, languages, location, availability, activeAssignment, totalHours, certificates);
  }

  assignTo(villageId: VillageId, role: string, now: Date): Volunteer {
    return new Volunteer(
      this.id,
      this.name,
      this.contact,
      this.skills,
      this.languages,
      this.location,
      this.availability,
      { villageId, role, since: now },
      this.totalHours,
      this.certificates,
    );
  }

  unassign(): Volunteer {
    return new Volunteer(
      this.id,
      this.name,
      this.contact,
      this.skills,
      this.languages,
      this.location,
      this.availability,
      null,
      this.totalHours,
      this.certificates,
    );
  }

  logHours(hours: number, newCertificates: readonly string[]): Volunteer {
    return new Volunteer(
      this.id,
      this.name,
      this.contact,
      this.skills,
      this.languages,
      this.location,
      this.availability,
      this.activeAssignment,
      this.totalHours + hours,
      [...this.certificates, ...newCertificates],
    );
  }
}
