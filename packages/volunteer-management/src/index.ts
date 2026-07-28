// Domain
export { Volunteer, type Availability, type Assignment, type VolunteerCreateProps } from "./domain/volunteer.js";

// Application
export { RegisterVolunteer, type RegisterVolunteerInput, type RegisterVolunteerOutput, type RegisterVolunteerDeps } from "./application/register-volunteer.js";
export { SetAvailability, type SetAvailabilityInput, type SetAvailabilityOutput, type SetAvailabilityDeps } from "./application/set-availability.js";
export { AssignVolunteer, type AssignVolunteerInput, type AssignVolunteerOutput, type AssignVolunteerDeps } from "./application/assign-volunteer.js";
export { LogHours, type LogHoursInput, type LogHoursOutput, type LogHoursDeps } from "./application/log-hours.js";
export { Leaderboard, type LeaderboardEntry, type LeaderboardOutput, type LeaderboardDeps } from "./application/leaderboard.js";
export { type VolunteerRepository } from "./application/ports.js";

// Adapters
export { InMemoryVolunteerRepository } from "./adapters/in-memory-volunteer-repository.js";
