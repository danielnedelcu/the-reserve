import { z } from "zod";
import { EMAIL_PATTERN } from "../forms/fields";
import { LEAD_INTERESTS, LEAD_HONEYPOT_FIELD } from "./constants";

/**
 * The shape a public landing page may POST to /api/public/leads.
 *
 * STRICT: an unknown key is a rejection, never silently dropped — the
 * posted shape is the one thing an open endpoint cannot trust, and a key
 * that "fell through" once is how a client learns it can send anything.
 * Every string is bounded; the enum is the closed interest set; consent
 * is a boolean and nothing else — the TIMESTAMP is never accepted from
 * the client, the server stamps it (see the route).
 *
 * Shared so the eventual landing-page form can validate the same way
 * before posting; the server's parse is the one that counts.
 */
export const leadCaptureSchema = z.strictObject({
  first_name: z.string().trim().min(1, "First name is required").max(80),
  last_name: z.string().trim().min(1, "Last name is required").max(80),
  email: z
    .string()
    .trim()
    .max(254)
    .refine((v) => EMAIL_PATTERN.test(v), { message: "Enter a valid email address" }),
  phone: z.string().trim().max(40).optional(),
  interest: z.enum(LEAD_INTERESTS, { message: "interest must be one of the allowed values" }),
  /** Which landing page or campaign. Absent → the database default 'manual'. */
  source: z.string().trim().min(1).max(120).optional(),
  consent: z.boolean().optional(),
  /** The honeypot. Allowed so a filled one is CAUGHT, not rejected as unknown. */
  [LEAD_HONEYPOT_FIELD]: z.string().max(200).optional(),
});

export type LeadCaptureInput = z.infer<typeof leadCaptureSchema>;

/** Largest request body the endpoint will read. A lead is a few hundred bytes. */
export const LEAD_CAPTURE_MAX_BYTES = 4096;
