import { timingSafeEqual } from "node:crypto";
import { serverSupabaseServiceRole } from "#supabase/server";
import type { Json } from "~~/shared/types/database";
import { sendMail } from "../../utils/mailer";
import {
  dayBeforeReminderEmail,
  intakeReminderEmail,
  postVisitFollowupEmail,
  birthdayEmail,
} from "../../utils/emailTemplates";
import { getDefinition } from "../../utils/formEngine";
import {
  isJobKind,
  blockedByOptIn,
  deliveryChannel,
  localDateKey,
  localDayWindow,
  localYearStart,
  isBirthday,
  alreadySentForAppointment,
  alreadySentThisYear,
  lateCancellationCutoff,
  type JobKind,
  type SentRow,
} from "../../utils/communicationJobs";

/**
 * POST /api/jobs/communications   Body: { job: JobKind }
 *
 * The scheduled communications (client communications, phase 3 —
 * docs/design/client-communications-design.md). pg_cron is the clock:
 * run_communication_job() POSTs here nightly, once per job, presenting
 * the bearer secret from Vault. The route does the work under the
 * service role: select the candidates per location, consult
 * communications_sent (the dedup guard), send with the shared templates,
 * and write the sent-log row ONLY when Resend accepts — a false row
 * would silence every retry (the phase 2 invariant).
 *
 * No JWT here, so organization_id is always the appointment's or the
 * client's own — never current_org_id(), which is null under the
 * service role. Windows are the LOCATION'S local days (localDayWindow,
 * built on localToUtc like the slots route). Only jobs 3 and 4 honour
 * communication_opted_in; 1 and 2 are transactional.
 *
 * Fails closed: no configured secret => 503; wrong or missing bearer =>
 * 401. Every per-recipient failure is counted and logged, never thrown,
 * so one bad address cannot stop the rest of the run.
 */

const INTAKE_REMINDER_DAYS_BEFORE = 3;
/** Existing-client waiver — the form the booking gate looks for. */
const INTAKE_FORM_KEY = "service_waiver";

interface Location {
  id: string;
  organization_id: string;
  name: string;
  timezone: string;
  phone: string | null;
}
interface ClientBits {
  email: string | null;
  first_name: string;
  communication_channel: string;
  communication_opted_in: boolean;
}
interface Appt {
  id: string;
  organization_id: string;
  client_id: string;
  booked_by: string;
  starts_at: string;
  status: string;
  client: ClientBits | null;
  staff: { display_name: string } | null;
  appointment_services: {
    name_snapshot: string;
    service: { requires_intake: boolean } | null;
  }[];
  cancellation_tokens: { id: string; used_at: string | null }[];
}

interface Tally {
  job: JobKind;
  locations: number;
  candidates: number;
  sent: number;
  skipped: {
    alreadySent: number;
    optedOut: number;
    noEmail: number;
    other: number;
  };
  failed: number;
}

export default defineEventHandler(async (event) => {
  // --- Gate ------------------------------------------------------------------
  const expected = useRuntimeConfig(event).communicationsJobSecret;
  if (!expected) {
    throw createError({
      statusCode: 503,
      statusMessage:
        "Scheduled communications are not configured on this server (missing NUXT_COMMUNICATIONS_JOB_SECRET).",
    });
  }
  const presented = (getHeader(event, "authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const body = await readBody<{ job?: unknown }>(event);
  if (!isJobKind(body?.job)) {
    throw createError({
      statusCode: 400,
      statusMessage:
        "job must be one of day_before_reminder | intake_reminder | post_visit_followup | birthday",
    });
  }
  const job = body.job;

  const admin = serverSupabaseServiceRole(event);
  const now = new Date();
  const base =
    useRuntimeConfig(event).public.siteUrl || getRequestURL(event).origin;

  const { data: locations, error: locError } = await admin
    .from("locations")
    .select("id, organization_id, name, timezone, phone")
    .eq("active", true);
  if (locError) {
    throw createError({ statusCode: 500, statusMessage: locError.message });
  }

  const tally: Tally = {
    job,
    locations: locations?.length ?? 0,
    candidates: 0,
    sent: 0,
    skipped: { alreadySent: 0, optedOut: 0, noEmail: 0, other: 0 },
    failed: 0,
  };

  // The sent-log write. Only ever called after sendMail returned true.
  async function logSent(row: {
    organization_id: string;
    client_id: string;
    appointment_id: string | null;
    metadata: Json;
  }) {
    const { error } = await admin.from("communications_sent").insert({
      ...row,
      kind: job,
      channel: "email",
    });
    if (error) {
      console.error(
        `[communications:${job}] sent but not logged:`,
        error.message,
      );
    }
  }

  for (const loc of (locations ?? []) as Location[]) {
    try {
      if (job === "birthday") {
        await runBirthday(loc);
      } else {
        await runAppointmentJob(loc, job);
      }
    } catch (error) {
      tally.failed++;
      console.error(
        `[communications:${job}] location ${loc.id} failed:`,
        error,
      );
    }
  }

  return tally;

  // --- Jobs 1–3: one appointment per candidate ------------------------------
  async function runAppointmentJob(
    loc: Location,
    kind: Exclude<JobKind, "birthday">,
  ) {
    const offset =
      kind === "day_before_reminder"
        ? 1
        : kind === "intake_reminder"
          ? INTAKE_REMINDER_DAYS_BEFORE
          : -1;
    const window = localDayWindow(now, loc.timezone, offset);

    let query = admin
      .from("appointments")
      .select(
        "id, organization_id, client_id, booked_by, starts_at, status, client:clients(email, first_name, communication_channel, communication_opted_in), staff:staff!appointments_staff_id_fkey(display_name), appointment_services(name_snapshot, service:services(requires_intake)), cancellation_tokens(id, used_at)",
      )
      .eq("organization_id", loc.organization_id)
      .gte("starts_at", window.from.toISOString())
      .lt("starts_at", window.to.toISOString());
    query =
      kind === "post_visit_followup"
        ? query.eq("status", "completed")
        : query.not("status", "in", "(cancelled,no_show)");

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    let appts = (data ?? []) as unknown as Appt[];

    if (kind === "intake_reminder") {
      // Only services that require intake, and only clients with NO
      // completed waiver — ANY version counts, the booking gate's rule.
      appts = appts.filter((a) =>
        a.appointment_services.some((s) => s.service?.requires_intake),
      );
      if (appts.length) {
        const { data: done } = await admin
          .from("form_responses")
          .select("client_id")
          .in(
            "client_id",
            appts.map((a) => a.client_id),
          );
        const covered = new Set((done ?? []).map((r) => r.client_id));
        appts = appts.filter((a) => !covered.has(a.client_id));
      }
    }
    tally.candidates += appts.length;
    if (!appts.length) return;

    const { data: sent } = await admin
      .from("communications_sent")
      .select("client_id, appointment_id, kind, sent_at")
      .eq("kind", kind)
      .in(
        "appointment_id",
        appts.map((a) => a.id),
      );
    const sentRows = (sent ?? []) as SentRow[];

    let waiver: Awaited<ReturnType<typeof getDefinition>> | null = null;
    if (kind === "intake_reminder") {
      waiver = await getDefinition(admin, INTAKE_FORM_KEY);
      if (!waiver?.currentVersion) {
        console.error(
          `[communications:intake_reminder] no published "${INTAKE_FORM_KEY}" form — nothing sent`,
        );
        tally.skipped.other += appts.length;
        return;
      }
    }

    for (const appt of appts) {
      try {
        if (alreadySentForAppointment(sentRows, appt.id, kind)) {
          tally.skipped.alreadySent++;
          continue;
        }
        const client = appt.client;
        if (!client?.email) {
          tally.skipped.noEmail++;
          continue;
        }
        if (blockedByOptIn(kind, client.communication_opted_in)) {
          tally.skipped.optedOut++;
          continue;
        }
        // TODO(sms): resolves to email until the SMS phase.
        const channel = deliveryChannel(client.communication_channel);
        const serviceName =
          appt.appointment_services[0]?.name_snapshot ?? "your appointment";
        const staffName = appt.staff?.display_name ?? "your provider";

        let content: { subject: string; html: string };
        let metadata: Json;

        if (kind === "day_before_reminder") {
          const token = appt.cancellation_tokens.find((t) => !t.used_at);
          const cancelUrl = token ? `${base}/cancel/${token.id}` : null;
          const cutoff = lateCancellationCutoff(appt.starts_at).toISOString();
          content = dayBeforeReminderEmail({
            clientFirstName: client.first_name,
            serviceName,
            staffName,
            startsAtIso: appt.starts_at,
            timezone: loc.timezone,
            location: { name: loc.name, phone: loc.phone },
            cancelUrl,
            feeCutoffIso: cutoff,
          });
          metadata = {
            service_name: serviceName,
            staff_name: staffName,
            starts_at: appt.starts_at,
            cancel_url: cancelUrl,
            fee_cutoff: cutoff,
          };
        } else if (kind === "intake_reminder") {
          // The same form-link machinery the send dialog uses, issued on
          // behalf of the staff member who booked (issued_by is not null
          // and a job has no staff identity of its own).
          const { data: link, error: linkError } = await admin
            .from("form_links")
            .insert({
              organization_id: appt.organization_id,
              form_version_id: waiver!.currentVersion!.id,
              client_id: appt.client_id,
              delivery_email: client.email,
              issued_by: appt.booked_by,
              expires_at: appt.starts_at,
            })
            .select("token")
            .single();
          if (linkError || !link) {
            throw new Error(linkError?.message ?? "form link not issued");
          }
          const formUrl = `${base}/join/${link.token}`;
          content = intakeReminderEmail({
            clientFirstName: client.first_name,
            serviceName,
            startsAtIso: appt.starts_at,
            timezone: loc.timezone,
            formUrl,
            formName: waiver!.name,
          });
          metadata = {
            service_name: serviceName,
            starts_at: appt.starts_at,
            form_key: INTAKE_FORM_KEY,
            form_url: formUrl,
          };
        } else {
          const rebookUrl = base;
          content = postVisitFollowupEmail({
            clientFirstName: client.first_name,
            serviceName,
            rebookUrl,
          });
          metadata = {
            service_name: serviceName,
            starts_at: appt.starts_at,
            rebook_url: rebookUrl,
          };
        }

        const emailed = await sendMail({ to: client.email, ...content });
        if (!emailed) {
          tally.failed++;
          console.error(
            `[communications:${kind}] send failed for appointment ${appt.id}`,
          );
          continue;
        }
        await logSent({
          organization_id: appt.organization_id,
          client_id: appt.client_id,
          appointment_id: appt.id,
          metadata: {
            ...metadata,
            channel_preference: client.communication_channel,
            channel,
          },
        });
        tally.sent++;
      } catch (error) {
        tally.failed++;
        console.error(
          `[communications:${kind}] appointment ${appt.id}:`,
          error,
        );
      }
    }
  }

  // --- Job 4: one client per candidate, once per calendar year --------------
  async function runBirthday(loc: Location) {
    const today = localDateKey(now, loc.timezone);
    // Active client records — deactivated clients are not written to.
    const { data, error } = await admin
      .from("clients")
      .select(
        "id, organization_id, email, first_name, date_of_birth, communication_channel, communication_opted_in",
      )
      .eq("organization_id", loc.organization_id)
      .eq("active", true)
      .not("date_of_birth", "is", null);
    if (error) throw new Error(error.message);

    const celebrants = (data ?? []).filter((c) =>
      isBirthday(c.date_of_birth, today),
    );
    tally.candidates += celebrants.length;
    if (!celebrants.length) return;

    const yearStart = localYearStart(now, loc.timezone);
    const { data: sent } = await admin
      .from("communications_sent")
      .select("client_id, appointment_id, kind, sent_at")
      .eq("kind", "birthday")
      .gte("sent_at", yearStart.toISOString())
      .in(
        "client_id",
        celebrants.map((c) => c.id),
      );
    const sentRows = (sent ?? []) as SentRow[];

    for (const client of celebrants) {
      try {
        if (alreadySentThisYear(sentRows, client.id, "birthday", yearStart)) {
          tally.skipped.alreadySent++;
          continue;
        }
        if (!client.email) {
          tally.skipped.noEmail++;
          continue;
        }
        if (blockedByOptIn("birthday", client.communication_opted_in)) {
          tally.skipped.optedOut++;
          continue;
        }
        // TODO(sms): resolves to email until the SMS phase.
        const channel = deliveryChannel(client.communication_channel);
        const content = birthdayEmail({ clientFirstName: client.first_name });
        const emailed = await sendMail({ to: client.email, ...content });
        if (!emailed) {
          tally.failed++;
          console.error(
            `[communications:birthday] send failed for client ${client.id}`,
          );
          continue;
        }
        await logSent({
          organization_id: client.organization_id,
          client_id: client.id,
          appointment_id: null,
          metadata: {
            local_date: today,
            channel_preference: client.communication_channel,
            channel,
          },
        });
        tally.sent++;
      } catch (error) {
        tally.failed++;
        console.error(`[communications:birthday] client ${client.id}:`, error);
      }
    }
  }
});
