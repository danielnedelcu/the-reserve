import type { FormField } from "./fields";

/**
 * Starting points, so nobody faces a blank page.
 *
 * The prospect template PRE-SATISFIES the reserved-contact-key contract —
 * first_name, last_name and email present, required, and non-sensitive.
 * That rule exists because those answers become the person's record, and
 * meeting it in the seed is the difference between a requirement that is
 * invisible-because-met and one that first appears as a validation error
 * to someone who has never heard of it.
 *
 * Health questions arrive already marked sensitive, for the same reason:
 * the safe setting should be the one you get without knowing to ask.
 */

export interface FormTemplate {
  key: string;
  name: string;
  description: string;
  consentText: string;
  fields: FormField[];
}

export const PROSPECT_INTAKE_TEMPLATE: FormTemplate = {
  key: "prospect_intake",
  name: "Join The Reserve",
  description: "A few questions before your first visit. It takes about two minutes.",
  consentText:
    "I confirm the information I have given is accurate. I understand that The Reserve provides massage and wellness services, not medical care, and that I should speak to a doctor about any medical concern.",
  fields: [
    { key: "first_name", label: "First name", type: "text", required: true, sensitive: false },
    { key: "last_name", label: "Last name", type: "text", required: true, sensitive: false },
    { key: "email", label: "Email address", type: "email", required: true, sensitive: false },
    {
      key: "phone",
      label: "Mobile number",
      type: "phone",
      required: false,
      sensitive: false,
      help: "So we can reach you about your visit.",
    },
    { key: "date_of_birth", label: "Date of birth", type: "date", required: false, sensitive: false },
    {
      key: "referral",
      label: "How did you hear about us?",
      type: "select",
      required: false,
      sensitive: false,
      options: ["A friend or family member", "Online", "Walked past", "Another member", "Somewhere else"],
    },
    {
      key: "focus_areas",
      label: "What would you like us to focus on?",
      type: "multiselect",
      required: false,
      sensitive: false,
      options: ["Neck and shoulders", "Lower back", "Legs and feet", "Full body", "Not sure yet"],
    },
    {
      key: "health_conditions",
      label: "Is there anything about your health we should know?",
      type: "textarea",
      required: false,
      sensitive: true,
      help: "Injuries, recent surgery, anything that hurts. Only our therapists see this.",
    },
    {
      key: "pregnancy",
      label: "Are you currently pregnant?",
      type: "boolean",
      required: false,
      sensitive: true,
    },
    {
      key: "medications",
      label: "Are you taking any medication we should know about?",
      type: "textarea",
      required: false,
      sensitive: true,
      help: "Only if it might affect your treatment. Leave blank if you would rather talk about it in person.",
    },
  ],
};

export const SERVICE_WAIVER_TEMPLATE: FormTemplate = {
  key: "service_waiver",
  name: "Treatment consent",
  description: "A short consent form to sign before your treatment.",
  consentText:
    "I consent to receive the treatment I have booked. I understand that The Reserve provides massage and wellness services, not medical care. I have told my therapist about any health condition that could affect my treatment, and I will tell them if anything changes or becomes uncomfortable during the session.",
  fields: [
    // No contact fields: a waiver is sent to someone who is ALREADY a
    // client, so the link carries client_id and nothing is promoted.
    {
      key: "health_changes",
      label: "Has anything about your health changed since your last visit?",
      type: "textarea",
      required: false,
      sensitive: true,
      help: "New injuries, surgery, medication, or anything that hurts.",
    },
    {
      key: "pressure_preference",
      label: "How much pressure do you prefer?",
      type: "select",
      required: false,
      sensitive: false,
      options: ["Light", "Medium", "Firm", "Whatever you recommend"],
    },
    {
      key: "areas_to_avoid",
      label: "Anywhere you would like us to avoid?",
      type: "textarea",
      required: false,
      sensitive: false,
    },
  ],
};

export const FORM_TEMPLATES: FormTemplate[] = [
  PROSPECT_INTAKE_TEMPLATE,
  SERVICE_WAIVER_TEMPLATE,
];
