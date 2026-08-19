# Wellness/Spa Center Platform — Requirements Document

**Version:** Draft v1
**Scope:** In-house web application for spa operations. Client-facing online booking is explicitly out of scope for v1 but the design must not preclude it.

---

## 1. Authentication & Access Control

- **User authentication** — Secure login for all staff users (email/password at minimum; magic link or SSO optional). Session management, password reset, and account lockout after repeated failures.
- **Multi-tenant role system** — Every user belongs to the organization and holds one or more roles. Permissions are data-driven (see Permission Matrix, Appendix A), not hard-coded role checks, so new roles can be created without code changes.
- **System roles** — Four seeded roles: Super Admin, Admin, Front Desk, Provider. Super Admins can clone and customize roles. The system must prevent removal or demotion of the last Super Admin.
- **Employee invitation & signup** — Admins invite new employees by email; invitee completes their profile (name, title, credentials/certifications) and sets credentials. Accounts are inactive until the invite is accepted; admins can deactivate staff at any time (deactivation revokes access but preserves historical records).
- **Audit logging** — Append-only log of security-relevant and sensitive actions: logins, permission changes, refunds, data exports, health-note access, appointment deletions/edits, membership changes. Visible to Super Admins only. Records can never be edited or deleted.

## 2. Client Management

- **New client signup / intake** — Staff-driven client creation capturing contact info, emergency contact, communication preferences, and referral source. Duplicate detection on email/phone.
- **Client profiles** — Central record showing contact details, membership status, complete service history, upcoming appointments, payment methods on file, no-show history, and notes.
- **Intake forms, waivers & health history** — Digital consent forms with signature capture and versioning (know which version of the waiver each client signed and when). Health/contraindication screening (allergies, pregnancy, injuries, medications). Services can be flagged as requiring a completed intake before booking.
- **Client notes with tiered sensitivity** — Three note types with different access rules: preference notes ("prefers firm pressure"), health notes (contraindications — providers and admins only, never front desk), and internal notes. All note access to health notes is audit-logged.
- **No-show & cancellation tracking** — Per-client counters and flags (e.g., "requires card on file") that feed the cancellation policy engine.

## 3. Membership Management

- **Membership tiers** — Configurable tiers with pricing, billing frequency, included services/credits, discounts, and perks. Tier definitions are editable without affecting existing members retroactively unless explicitly migrated.
- **Member lifecycle** — Enrollment, tier upgrades/downgrades, pause/freeze (with configurable max duration), and cancellation flows. Cancellation must be straightforward (regulatory attention on subscription cancellation is real).
- **Client goals tracking** — Wellness goals per client (e.g., stress reduction, recovery), progress notes, and linkage to services received.
- **Service history ledger** — Comprehensive, immutable record of every service provided: what, when, by whom, price paid, membership credits consumed.
- **Recurring billing & dunning** — Automated membership billing, failed-payment retry logic, card-update request emails, and configurable suspension rules after repeated failures.

## 4. Service Catalog

- **Service definitions** — Name, category, description, client-facing duration, price, and active/inactive status.
- **Buffer times** — Per-service prep and cleanup/turnover minutes, modeled separately from client-facing duration; the scheduler blocks the full window.
- **Staff qualifications** — Explicit mapping of which staff may perform which services, with optional per-staff duration and price overrides (e.g., senior therapist pricing).
- **Resource requirements** — Each service declares the room/equipment type it needs (massage room, facial room, sauna). Specific rooms belong to types; the scheduler assigns a concrete free room at booking.
- **Packages & bundles** — Multi-session packages (e.g., 5-massage pack) with per-session redemption tracking.

## 5. Scheduling & Calendar

- **Org-wide calendar** — Full schedule view across all staff and rooms, visible per requirement to everyone in the org (day/week views, filter by staff, room, or service). Whether providers see the full calendar or only their own is an org-level setting.
- **Personal calendar views** — Each employee sees their own schedule, upcoming appointments, and assigned clients.
- **Staff-driven booking** — Employees (per permission) book clients into computed open slots. Open slots derive from: staff availability rules − time-off/exceptions − existing bookings ∩ free qualifying room ∩ business hours.
- **Conflict prevention** — Double-booking of a staff member or room must be impossible, including under simultaneous booking attempts by different users. Admins may hold an explicit override permission for exceptional cases.
- **Staff availability management** — Recurring weekly working hours per staff member (with effective date ranges), plus exceptions: time off, sick days, breaks, extra shifts. Time-off requests flow through an approval step (request → approve/deny by admins).
- **Appointment lifecycle** — Statuses: booked → confirmed → checked-in → in-progress → completed; or cancelled / no-show. Appointments are never deleted — only status-transitioned — preserving history for analytics and policy enforcement.
- **Multi-service appointments** — A single appointment can include multiple services (massage + facial) with combined duration and room/staff handoffs where applicable.
- **Price/duration snapshotting** — Appointments capture service name, price, and duration at booking time so later catalog changes don't rewrite history.
- **Walk-ins & rescheduling** — Walk-ins are immediate appointments (no separate flow). Rescheduling preserves the appointment record and its history.
- **Waitlists** — Clients can be waitlisted for full time slots and notified/offered the slot on cancellation.
- **Cancellation / no-show policy engine** — Configurable rules: cancellation windows, late-cancel fees, no-show fees, card-on-file requirements for repeat offenders.

## 6. Client Notifications (Automated)

- **Appointment communications** — Booking confirmations, reminders (e.g., 24h and 2h before), reschedule and cancellation notices, via email and/or SMS per client preference.
- **Membership communications** — Payment receipts, failed-payment notices, renewal reminders, freeze/cancellation confirmations.
- **Delivery via established provider** — Use a transactional email/SMS provider (e.g., SendGrid/Resend + Twilio); do not build delivery infrastructure in-house. All sends logged per client.

## 7. Point of Sale & Payments

- **Checkout flow** — Take payment for services, packages, retail products, and gift cards at time of service; support cash, card, card-on-file, membership credits, and gift card redemption in a single transaction.
- **Card-present checkout via payment terminal** — Physical, processor-certified smart readers (e.g., Stripe Terminal — Stripe Reader S700/WisePOS E) at each front desk, controlled by the web app via a server-driven integration (no native app required). Staff initiate the charge from the app; the customer taps card/phone/watch on the reader. Card data flows directly from reader to processor and never touches application systems or staff hands. Payment results arrive via webhooks and update the transaction ledger automatically. Readers are registered per location, aligning with the multi-location model. *Future option: Tap to Pay on staff phones for in-room checkout (requires a native app component).*
- **On-reader tip prompting** — The terminal prompts the customer for a tip with configurable percentage presets and custom amount; captured tips are attributed to the providing staff member.
- **Tap-to-save card on file** — During a card-present checkout, the customer's card can be saved for future off-session use (e.g., `setup_future_usage` / on-reader SetupIntent), backing membership billing and cancellation/no-show fees — subject to the consent capture requirement below. One tap replaces all manual card entry.
- **Tipping** — Tip capture at checkout (on-reader or in-app for non-card payments), attributed to the providing staff member (feeds payroll/commission reporting).
- **Retail product catalog** — Simple product list (lotions, candles, supplements) with prices and basic stock counts.
- **Gift cards** — Issue, redeem, and check balances. Outstanding gift card balances tracked as a liability for financial reporting.
- **Card on file (tokenized)** — Raw card data is never stored or transmitted through the application's servers; cards are captured via the payment processor's hosted fields (e.g., Stripe Elements/Terminal) and stored as processor tokens. The database holds only the processor customer/payment-method IDs and display metadata (brand, last four, expiry). Cards saved for future off-session charging are validated via a SetupIntent (or processor equivalent). Keeps the platform in PCI SAQ-A scope.
- **Card-on-file consent capture** — Explicit, timestamped client authorization (checkbox at intake or signature on the waiver) that a stored card may be charged off-session per the cancellation/no-show policy. Consent records, appointment history, and reminder-notification logs are retained as evidence for dispute/chargeback defense.
- **Refunds & adjustments** — Permission-gated refunds with mandatory reason capture; every refund is audit-logged. Consider a higher-approval threshold for large refunds.
- **Transaction ledger** — Every financial event (sale, refund, membership charge, gift card issuance/redemption, tip) recorded immutably; this ledger is the single source of truth feeding the financial overview.

## 8. Marketing — Feedback Forms & Landing Pages

- **Templated form builder** — Marketing staff compose feedback forms from templates (choose layout, customize questions: rating scales, multiple choice, free text). *v1 constraint: templated, not a freeform page builder — a full custom page/form builder is deferred.*
- **Landing page generation** — Each form publishes to a shareable, branded landing page (Onward brand colors/logo per org settings).
- **Email distribution** — Send forms to selected clients or segments (e.g., all clients who received a service last month) via the transactional email provider, with send tracking.
- **Response collection & review** — Responses tied back to client records where identifiable; marketing/admins can view, filter, and export responses.
- **Post-visit automation (nice-to-have)** — Optionally auto-send a feedback form N hours after a completed appointment.

## 9. Internal Communication

- **Direct & group messaging** — Real-time messaging between employees, with unread indicators and basic notifications.
- **Org-wide broadcasts** — Admin-only announcements to all staff.
- **Contextual references (nice-to-have)** — Ability to reference a client or appointment in a message thread.

## 10. Analytics & Dashboards

- **Membership statistics dashboard** — Active members by tier, new signups, churn/cancellations, freezes, MRR from memberships, tier migration trends.
- **Operational analytics** — Bookings by service/staff/room, utilization rates (staff hours booked vs. available; room occupancy), no-show and cancellation rates, peak-time analysis, waitlist conversion.
- **Client analytics** — Retention/repeat-visit rates, average spend per visit, referral source performance, feedback form scores over time.
- **Per-provider view** — Providers see their own performance metrics (bookings, utilization, feedback) but never org-wide financial data.

## 11. Financial Overview (Admins & Super Admins Only)

- **Revenue reporting** — Revenue by category (services, memberships, retail, gift cards), by period, by location, and by staff member; comparison across periods.
- **Liabilities view** — Outstanding gift card balances and unredeemed package sessions.
- **Payroll-adjacent reporting** — Commission and tip summaries per staff member per pay period (exported to payroll; the app is not a payroll system).
- **Refund & adjustment reporting** — All refunds with reasons and issuing staff.
- **Export** — CSV/report export, gated to Super Admin.

## 12. Platform & Non-Functional Requirements

- **Multi-location ready** — Data model supports multiple locations from day one (rooms, staff assignments, and appointments are location-scoped) even if launching with one.
- **Timezone correctness** — All timestamps stored in UTC; availability rules stored in location-local time so recurring hours survive DST transitions.
- **Data sensitivity** — Health-adjacent client data treated as highly sensitive: separate storage, tightest access gating, audited access — even if not formally HIPAA-covered. Payment card data (PAN, CVV) must never be stored, logged, or transmitted through application servers under any circumstances — tokenization via the payment processor only.
- **Backbone** — Single backend for the whole application (recommendation: Supabase/Postgres — relational fit, row-level security aligned with the permission model, realtime for messaging, and database-level booking conflict prevention).
- **Branding** — Onward logo (full greyscale) and brand palette throughout: #92c9d6 (teal), #2f193b (dark purple), #572e72 (medium purple), #8260a2 (light purple).
- **Future-proofing for client-facing booking** — Scheduling model must support a later public "book online" portal without redesign.

---

## 13. AI-Assisted Features (Post-v1)

All features in this section are deferred beyond v1 but inform current design decisions. They are implemented as API calls to a foundation model provider (e.g., Anthropic Claude API) using the platform's own data — no in-house ML infrastructure. The clean data model and permission system in v1 are the prerequisites; the AI layer sits on top.

- **Feedback analysis** — Automated sentiment scoring, theme extraction, and anomaly flagging across free-text form responses (e.g., "3 clients mentioned Room 2 being cold this month"). Surfaces in the marketing/analytics dashboards. *Likely first AI feature: highest value-to-effort.*
- **Front-desk copilot (upsell/service suggestions)** — Contextual suggestions on the client profile or at check-in, generated from the client's service history, membership/package status, and the service catalog, guided by a configurable "playbook" prompt (org-editable sales guidance and tone). Suggestions are advisory only — staff decide whether to act.
- **AI-drafted client communications** — Personalized rebooking nudges, lapsed-member win-back emails, post-visit follow-ups, and marketing/landing-page copy drafted by the model. All drafts require human review and explicit send approval.
- **Analytics Q&A** — Natural-language questions against the transaction ledger and appointment data ("why was revenue down in March?"), answered via model tool-calls to predefined, permission-checked queries. Responses respect the asking user's permission scope.
- **Retention & no-show risk signals** — Periodic review of visit patterns to flag at-risk members and no-show-trending clients, each with a suggested intervention for staff review.
- **Natural-language scheduling assistant** — Conversational slot-finding ("find Maria 90 minutes with Jess or anyone senior on Thursday") built on the same deterministic availability engine as the standard scheduler. *Lowest priority: the deterministic slot-finder covers most of this need.*

### AI Guardrails (apply to all AI features)

- **Human-in-the-loop for client-facing output** — The model drafts and suggests; a staff member approves anything sent to a client. No autonomous client communication in the initial AI rollout.
- **Agent actions inherit user permissions** — AI features acting on behalf of a user are constrained by that user's permission set (Appendix A); model tool-calls are gated identically to UI actions.
- **Data-category allowlists per feature** — Each AI feature explicitly declares which data it may access. Health/contraindication notes are excluded from all marketing and upsell contexts (permitted only in explicit safety-check features, if built).
- **AI activity is audit-logged** — Model-generated suggestions acted upon, and any AI tool-call touching sensitive data, are recorded in the audit log.
- **No client data used for model training** — Provider API configuration must ensure submitted data is not used to train foundation models (standard on enterprise API tiers).

---

## Appendix A — Permission Matrix

Permissions follow a `domain.action.scope` convention where scope is **own** (records tied to the user) or **any** (all records). Roles are data: Super Admins can create new roles by combining permissions.

| Permission | Super Admin | Admin | Front Desk | Provider |
|---|---|---|---|---|
| **Appointments** |
| View own appointments | ✅ | ✅ | ✅ | ✅ |
| View all appointments (org calendar) | ✅ | ✅ | ✅ | ✅ ¹ |
| Create appointments | ✅ | ✅ | ✅ | ✅ |
| Edit own appointments | ✅ | ✅ | ✅ | ✅ |
| Edit any appointment | ✅ | ✅ | ✅ | ❌ |
| Cancel any appointment | ✅ | ✅ | ✅ | ❌ |
| Override booking conflicts | ✅ | ✅ | ❌ | ❌ |
| **Clients** |
| View clients | ✅ | ✅ | ✅ | ✅ |
| Create clients | ✅ | ✅ | ✅ | ❌ |
| Edit clients | ✅ | ✅ | ✅ | ❌ |
| View health notes | ✅ | ✅ | ❌ | ✅ ² |
| Create health notes | ✅ | ✅ | ❌ | ✅ |
| Export client data | ✅ | ✅ | ❌ | ❌ |
| Delete clients | ✅ | ❌ | ❌ | ❌ |
| **Schedule & Availability** |
| Edit own availability | ✅ | ✅ | ❌ | ✅ |
| Edit anyone's availability | ✅ | ✅ | ❌ | ❌ |
| Request time off | ✅ | ✅ | ✅ | ✅ |
| Approve time off | ✅ | ✅ | ❌ | ❌ |
| **Staff Management** |
| View staff directory | ✅ | ✅ | ✅ | ✅ |
| Invite new employees | ✅ | ✅ | ❌ | ❌ |
| Edit staff profiles | ✅ | ✅ | ❌ | ❌ |
| Deactivate staff | ✅ | ✅ | ❌ | ❌ |
| Manage roles & permissions | ✅ | ❌ | ❌ | ❌ |
| **Service Catalog** |
| View services | ✅ | ✅ | ✅ | ✅ |
| Manage services, rooms & pricing | ✅ | ✅ | ❌ | ❌ |
| **Payments & Memberships** |
| Take payments (POS) | ✅ | ✅ | ✅ | ❌ |
| Issue refunds | ✅ | ✅ | ❌ | ❌ |
| Manage memberships | ✅ | ✅ | ✅ | ❌ |
| Comp/discount memberships | ✅ | ✅ | ❌ | ❌ |
| **Financials** |
| View financial summary | ✅ | ✅ | ❌ | ❌ |
| View financial detail | ✅ | ✅ | ❌ | ❌ |
| View own earnings/commissions | ✅ | ✅ | ❌ | ✅ ³ |
| Export financial data | ✅ | ❌ | ❌ | ❌ |
| **Marketing & Forms** |
| Create/manage feedback forms | ✅ | ✅ | ❌ | ❌ |
| Send forms to clients | ✅ | ✅ | ❌ | ❌ |
| View form responses | ✅ | ✅ | ❌ | ❌ |
| **Analytics** |
| View org-wide analytics | ✅ | ✅ | ❌ | ❌ |
| View own performance analytics | ✅ | ✅ | ❌ | ✅ |
| **Messaging** |
| Send direct/group messages | ✅ | ✅ | ✅ | ✅ |
| Send org-wide broadcasts | ✅ | ✅ | ❌ | ❌ |
| **System** |
| View audit log | ✅ | ❌ | ❌ | ❌ |
| Manage org settings & branding | ✅ | ❌ | ❌ | ❌ |

¹ Configurable per org: providers may be restricted to their own calendar.
² Providers need health notes to safely perform services; front desk does not. All health-note access is audit-logged.
³ Own commissions/earnings only — never org-wide financials.

---

## Suggested Build Sequence

1. Auth + role/permission system
2. Service catalog + client profiles & intake
3. Scheduling core (availability, rooms, conflict-safe booking)
4. Memberships + POS/payments + transaction ledger
5. Automated client notifications
6. Dashboards & analytics
7. Internal messaging
8. Feedback forms & landing pages
9. Financial deep-dive reporting
10. AI-assisted features (starting with feedback analysis, then front-desk copilot)

Scheduling and payments are the heart of the system; messaging and the form builder are the most deferrable.
