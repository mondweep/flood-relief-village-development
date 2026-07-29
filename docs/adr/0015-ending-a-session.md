# ADR 0015 — Ending a session: deliberate, reachable, and automatic

**Status:** Accepted
**Extends:** ADR 0008 (Supabase Auth for identity)

## Context

ADR 0008 decided how a session *begins* and where its tokens live: the access token in memory, the
refresh token in `sessionStorage`, so closing the tab ends the session. It said nothing about how a
session *ends* on purpose, and the implementation reflected that.

A **Sign out** button was built, and it works — it revokes at GoTrue, clears the refresh token and
resets the page. But it lives inside the Operations view, one of five. A user signed in and reading
the District dashboard, the NGO portfolio, the village list or the public projection has no sign-out
anywhere on screen. This was reported by the platform owner as the feature not existing at all,
which is the correct conclusion to draw from a control you cannot see.

That matters more here than it would on most platforms, because of who uses it and on what. The PRD
describes field workers and village committee members, not people with a laptop each. A shared
tablet in a relief camp, handed between people, is the expected deployment. On such a device the
person who needs to end the session is often *not* the person who started it, and they will not
think to navigate to a particular tab first.

The data behind that session is the beneficiary register: names, household composition and aid
history of widows and orphaned children (ADR 0009).

There is also a gap ADR 0008's tab-close rule does not cover. A tab left open renews itself
indefinitely — the refresh token is spent automatically before each expiry, so an abandoned session
stays live for as long as the browser does. "Closing the tab ends it" is true and insufficient: the
failure mode is nobody closing the tab.

## Decision

### 1. Sign-out is reachable from every view

The session pill in the site header — already global, already showing who is signed in — becomes the
control. It is a button when there is a session to end, and inert text otherwise.

This is deliberately *not* a second sign-out button added to each view, and not a new navigation
item. The pill already answers "who am I signed in as?" from everywhere; making it also answer "stop
being signed in" puts the control where the question is already being asked. The Operations panel
keeps its button, because that is where someone who went looking for account settings will look.

### 2. Sign-out is best-effort at the server, unconditional locally

Unchanged from the existing implementation, and recorded here because it is easy to get wrong later:
the local session is cleared **whether or not GoTrue answers**. A sign-out that can fail is a
sign-out nobody can rely on, and the case where the network is down is exactly the case where
someone is handing the device to a stranger.

The GoTrue `/logout` call is still made first, so the refresh token is revoked server-side where
possible rather than merely forgotten locally.

### 3. An idle session ends itself

After **30 minutes** with no interaction the session is ended automatically, with a **60-second
warning** first that any interaction dismisses.

The number is a judgement, not a measurement, and it is a compromise between two real costs. Too
short and a district officer loses a half-completed damage assessment while reading a paper form on
their desk; the platform's write-heavy workflows are exactly the ones an aggressive timeout would
punish. Too long and the register sits open on an unattended tablet. Thirty minutes is longer than a
form takes to fill in and shorter than a lunch break.

The warning is not decoration. An unannounced sign-out mid-form reads as a bug, and the user's
response to a bug is to do the same thing again — so a silent timeout produces repeated lost work
and no understanding of why.

Interaction means a real signal of a person present: pointer, key, touch, scroll. Deliberately **not**
`visibilitychange` or a timer tick, either of which a backgrounded tab would fire on its own and keep
a session alive that nobody is attending.

### 4. What ending a session does not do

It does not clear anything the API holds. There is no server-side session to expire beyond the
refresh token — the API verifies JWTs statelessly (ADR 0008) — so an access token already issued
stays valid until it expires, at most an hour. Signing out prevents *renewal*; it cannot recall a
token already minted.

This is worth stating because it bounds what sign-out is worth: it protects against the next person
picking up the device, not against an attacker who has already extracted a token. Shortening that
window means shortening the access-token lifetime in the Supabase project, which is a dashboard
setting rather than a code change.

## Alternatives considered

**A sign-out item in the main navigation.** Rejected: the nav is a row of five dashboards, and an
action among five destinations is a misuse of that control — it also implies a sixth view.

**Idle timeout only, no global button.** Rejected. The requirement that prompted this was somebody
deliberately finishing work and looking for the way out. An automatic timeout serves the forgotten
case, not the intended one, and makes people wait for something they wanted to do now.

**A short absolute session lifetime instead of an idle timer.** Simpler, and rejected because it
expires people mid-task on a fixed schedule regardless of whether they are there — the worst of both
properties.

**Clearing the token on `visibilitychange`, i.e. sign out when the tab is hidden.** Genuinely
tempting for shared devices, and rejected: switching to another tab to look something up is normal,
and this would make the platform unusable alongside any other page.

**Prompting on unload.** Rejected as unreliable by design — modern browsers ignore or heavily
restrict it, and a security control that the browser may decline to run is not a control.

## Consequences

- Sign-out is now reachable from all five views, and the header pill carries a second meaning that
  its appearance must make obvious; a control that looks like a status readout and behaves like a
  button is worse than either.
- Anyone can end a session on a shared device without knowing where the Operations view is.
- The idle timer runs in every tab with a session, including ones showing only the public
  projection. That is intentional: the session is the tab's, not the view's.
- 30 minutes and 60 seconds are guesses. They will be wrong for somebody, and they are in one place
  so they are cheap to change once anyone has used this in a camp.
- Password reset (built alongside this) is reachable only from the email/password form, which is
  correct — an account that signs in with Google has no password to reset — but it does mean a user
  who signed in with a provider and expects a password will not find it. No change made; recorded so
  the next person to hear that complaint knows it is intended.
