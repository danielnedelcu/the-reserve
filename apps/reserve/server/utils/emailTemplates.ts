/**
 * Brand-styled email templates. Inline styles + table layout: the only
 * approach email clients respect. Palette matches the brand card.
 */

const COLORS = {
  ink: "#3b2f1e",
  soft: "#7a6c54",
  gold: "#b6975a",
  cream: "#ece3d0",
  paper: "#faf7f0",
};

function shell(content: string): string {
  return `<!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;background-color:${COLORS.cream};font-family:Georgia,'Times New Roman',serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLORS.cream};padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
          <tr><td align="center" style="padding-bottom:24px;">
            <p style="margin:0;font-size:20px;letter-spacing:5px;color:${COLORS.ink};">THE RESERVE</p>
            <p style="margin:6px 0 0;font-size:10px;letter-spacing:4px;color:${COLORS.soft};">WELLNESS CLUB</p>
            <div style="width:56px;height:1px;background-color:${COLORS.gold};margin:16px auto 0;"></div>
          </td></tr>
          <tr><td style="background-color:${COLORS.paper};border-radius:12px;padding:32px;color:${COLORS.ink};font-size:15px;line-height:1.6;">
            ${content}
          </td></tr>
          <tr><td align="center" style="padding-top:20px;">
            <p style="margin:0;font-size:11px;letter-spacing:2px;color:${COLORS.soft};">RESTORE &bull; RECONNECT &bull; RENEW</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
  </html>`;
}

function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto;"><tr>
      <td style="background-color:${COLORS.ink};border-radius:8px;">
        <a href="${url}" style="display:inline-block;padding:12px 28px;color:${COLORS.cream};text-decoration:none;font-size:14px;letter-spacing:1px;">${label}</a>
      </td></tr></table>`;
}

export function staffInviteEmail(options: {
  inviteUrl: string;
  invitedByName: string;
  title?: string | null;
}): { subject: string; html: string } {
  return {
    subject: "You're invited to join The Reserve",
    html: shell(`
        <p style="margin:0 0 16px;">Hello,</p>
        <p style="margin:0 0 16px;">
          ${options.invitedByName} has invited you to join the team at
          The Reserve Wellness Club${options.title ? ` as <strong>${options.title}</strong>` : ""}.
        </p>
        <p style="margin:0;">Create your account to get started:</p>
        ${button(options.inviteUrl, "ACCEPT INVITATION")}
        <p style="margin:0;font-size:12px;color:${COLORS.soft};">
          This invitation expires in 7 days. If you weren't expecting it, you can ignore this email.
        </p>
      `),
  };
}

export function formLinkEmail(options: {
  formUrl: string;
  formName: string;
  organizationName?: string;
  expiresInDays: number;
}): { subject: string; html: string } {
  // Plain language on purpose: this reaches people who are not members
  // yet, often older and not confident with forms. Short sentences, one
  // instruction, no jargon, and the link is a large tappable button.
  return {
    subject: `${options.formName} — ${options.organizationName ?? "The Reserve"}`,
    html: shell(`
        <p style="margin:0 0 16px;">Hello,</p>
        <p style="margin:0 0 16px;">
          Before your visit, we would like you to fill in a short form. It
          takes a couple of minutes.
        </p>
        ${button(options.formUrl, "OPEN THE FORM")}
        <p style="margin:0 0 16px;font-size:13px;">
          If the button does not work, copy this address into your browser:<br />
          <span style="word-break:break-all;">${options.formUrl}</span>
        </p>
        <p style="margin:0;font-size:12px;color:${COLORS.soft};">
          This link works once and expires in ${options.expiresInDays} days.
          If you have any trouble, call us and we will help.
        </p>
      `),
  };
}

export function bookingConfirmationEmail(options: {
  clientFirstName: string;
  serviceName: string;
  staffName: string;
  startsAtIso: string;
  timezone: string;
  /** Where the appointment is: name and whatever contact detail is set. */
  location: {
    name: string;
    phone?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  };
  /** The single-use cancel link (client communications, phase 2). */
  cancelUrl: string;
}): { subject: string; html: string } {
  // Content per docs/design/client-communications-design.md touchpoint 1:
  // service, provider, date/time, location, the cancel link, and the
  // policy note. Placeholder styling — the owner refines copy and design
  // before launch; what matters here is that everything required is
  // present. Plain, warm language: this reaches members, often older.
  const where = [
    options.location.name,
    [options.location.city, options.location.state, options.location.postalCode]
      .filter(Boolean)
      .join(", "),
  ]
    .filter(Boolean)
    .join(" · ");
  const when = new Date(options.startsAtIso).toLocaleString("en-US", {
    timeZone: options.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    subject: `Your appointment is confirmed — ${when}`,
    html: shell(`
        <p style="margin:0 0 16px;">Hi ${options.clientFirstName},</p>
        <p style="margin:0 0 16px;">Your appointment at The Reserve is confirmed:</p>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
               style="background-color:${COLORS.cream};border-radius:8px;margin:8px 0 20px;">
          <tr><td style="padding:18px 20px;">
            <p style="margin:0 0 6px;font-size:16px;"><strong>${options.serviceName}</strong></p>
            <p style="margin:0 0 4px;color:${COLORS.soft};">${when}</p>
            <p style="margin:0 0 4px;color:${COLORS.soft};">with ${options.staffName}</p>
            <p style="margin:0;color:${COLORS.soft};">${where}${
              options.location.phone ? ` · ${options.location.phone}` : ""
            }</p>
          </td></tr>
        </table>
        <p style="margin:0 0 16px;">
          If your plans change, you can cancel with the button below. Please
          do it as early as you can, so we can offer your time to another
          member.
        </p>
        ${button(options.cancelUrl, "CANCEL THIS APPOINTMENT")}
        <p style="margin:0 0 16px;font-size:13px;">
          If the button does not work, copy this address into your browser:<br />
          <span style="word-break:break-all;">${options.cancelUrl}</span>
        </p>
        <p style="margin:0;font-size:13px;color:${COLORS.soft};">
          Cancellations within 24 hours of your appointment may incur a fee.
          Your first late cancellation is waived as a courtesy.
        </p>
      `),
  };
}

export function receiptEmail(options: {
  firstName: string | null;
  items: { name: string; quantity: number; totalCents: number }[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
}) {
  const dollars = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

  const itemRows = options.items
    .map(
      (item) => `
      <tr>
        <td style="padding:6px 0;color:#3b3428;font-size:14px;">
          ${item.name}${item.quantity > 1 ? ` &times; ${item.quantity}` : ""}
        </td>
        <td style="padding:6px 0;color:#3b3428;font-size:14px;text-align:right;white-space:nowrap;">
          ${item.totalCents < 0 ? "&minus;" : ""}${dollars(item.totalCents)}
        </td>
      </tr>`,
    )
    .join("");

  const summaryRow = (
    label: string,
    cents: number,
    options_?: { bold?: boolean; negative?: boolean },
  ) =>
    cents === 0 && !options_?.bold
      ? ""
      : `<tr>
          <td style="padding:3px 0;color:${options_?.bold ? "#2a2419" : "#8a7d63"};font-size:${options_?.bold ? "15px" : "13px"};${options_?.bold ? "font-weight:600;" : ""}">${label}</td>
          <td style="padding:3px 0;color:${options_?.bold ? "#2a2419" : "#8a7d63"};font-size:${options_?.bold ? "15px" : "13px"};text-align:right;${options_?.bold ? "font-weight:600;" : ""}">${options_?.negative ? "&minus;" : ""}${dollars(cents)}</td>
        </tr>`;

  const body = `
    <p style="margin:0 0 16px;color:#3b3428;font-size:15px;line-height:1.6;">
      ${options.firstName ? `Hi ${options.firstName},` : "Hello,"} thank you for visiting The Reserve.
      Here's your receipt.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5dcc8;border-bottom:1px solid #e5dcc8;margin:8px 0;">
      ${itemRows}
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${summaryRow("Subtotal", options.subtotalCents)}
      ${summaryRow("Discount", options.discountCents, { negative: true })}
      ${summaryRow("Tax", options.taxCents)}
      ${summaryRow("Gratuity", options.tipCents)}
      ${summaryRow("Total", options.totalCents, { bold: true })}
    </table>
    <p style="margin:20px 0 0;color:#8a7d63;font-size:13px;line-height:1.6;">
      We look forward to seeing you again.
    </p>`;

  // Wrap in the same brand shell the other templates use:
  return shell(body);
}

// ---------------------------------------------------------------------------
// Client communications, phase 3 — the four scheduled touchpoints
// (docs/design/client-communications-design.md). Content is what the doc
// specifies; styling is placeholder until the owner refines copy and
// design. Plain, warm language: this reaches members, often older.
// ---------------------------------------------------------------------------

function whenLabel(startsAtIso: string, timezone: string): string {
  return new Date(startsAtIso).toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function dayBeforeReminderEmail(options: {
  clientFirstName: string;
  serviceName: string;
  staffName: string;
  startsAtIso: string;
  timezone: string;
  location: { name: string; phone?: string | null };
  /** Null when the booking predates cancel tokens (phase 2). */
  cancelUrl: string | null;
  /** 24 hours before the start — after this a fee applies. */
  feeCutoffIso: string;
}): { subject: string; html: string } {
  const when = whenLabel(options.startsAtIso, options.timezone);
  const cutoff = new Date(options.feeCutoffIso).toLocaleString("en-US", {
    timeZone: options.timezone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    subject: `Your appointment is tomorrow — ${when}`,
    html: shell(`
        <p style="margin:0 0 16px;">Hi ${options.clientFirstName},</p>
        <p style="margin:0 0 16px;">A reminder that your appointment is tomorrow:</p>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
               style="background-color:${COLORS.cream};border-radius:8px;margin:8px 0 20px;">
          <tr><td style="padding:18px 20px;">
            <p style="margin:0 0 6px;font-size:16px;"><strong>${options.serviceName}</strong></p>
            <p style="margin:0 0 4px;color:${COLORS.soft};">${when}</p>
            <p style="margin:0 0 4px;color:${COLORS.soft};">with ${options.staffName}</p>
            <p style="margin:0;color:${COLORS.soft};">${options.location.name}${
              options.location.phone ? ` · ${options.location.phone}` : ""
            }</p>
          </td></tr>
        </table>
        ${
          options.cancelUrl
            ? `<p style="margin:0 0 16px;">If you can no longer make it, please cancel with the button below.</p>
        ${button(options.cancelUrl, "CANCEL THIS APPOINTMENT")}`
            : `<p style="margin:0 0 16px;">If you can no longer make it, please call us as early as you can.</p>`
        }
        <p style="margin:0;font-size:13px;color:${COLORS.soft};">
          Cancellations after ${cutoff} will incur a $50 late cancellation fee.
          Your first late cancellation is waived as a courtesy; later ones
          will be charged.
        </p>
      `),
  };
}

export function intakeReminderEmail(options: {
  clientFirstName: string;
  serviceName: string;
  startsAtIso: string;
  timezone: string;
  formUrl: string;
  formName: string;
}): { subject: string; html: string } {
  const when = whenLabel(options.startsAtIso, options.timezone);
  return {
    subject: `Before your ${options.serviceName} — a short form to complete`,
    html: shell(`
        <p style="margin:0 0 16px;">Hi ${options.clientFirstName},</p>
        <p style="margin:0 0 16px;">
          Your ${options.serviceName} is coming up on ${when}. Before then, we
          need you to complete a short form — it takes a couple of minutes.
        </p>
        ${button(options.formUrl, `OPEN ${options.formName.toUpperCase()}`)}
        <p style="margin:0 0 16px;font-size:13px;">
          If the button does not work, copy this address into your browser:<br />
          <span style="word-break:break-all;">${options.formUrl}</span>
        </p>
        <p style="margin:0;font-size:12px;color:${COLORS.soft};">
          This link works once. If you have any trouble, call us and we will
          help.
        </p>
      `),
  };
}

export function postVisitFollowupEmail(options: {
  clientFirstName: string;
  serviceName: string;
  rebookUrl: string;
}): { subject: string; html: string } {
  return {
    subject: "Thank you for visiting The Reserve",
    html: shell(`
        <p style="margin:0 0 16px;">Hi ${options.clientFirstName},</p>
        <p style="margin:0 0 16px;">
          Thank you for your visit — we hope you enjoyed your
          ${options.serviceName}.
        </p>
        <p style="margin:0 0 16px;">
          Whenever you are ready for your next one, we would love to see you
          again.
        </p>
        ${button(options.rebookUrl, "BOOK YOUR NEXT VISIT")}
      `),
  };
}

export function birthdayEmail(options: { clientFirstName: string }): {
  subject: string;
  html: string;
} {
  return {
    subject: `Happy birthday, ${options.clientFirstName}`,
    html: shell(`
        <p style="margin:0 0 16px;">Hi ${options.clientFirstName},</p>
        <p style="margin:0 0 16px;">
          Everyone at The Reserve wishes you a very happy birthday. We hope
          your day is restful and that we see you soon.
        </p>
        <p style="margin:0;color:${COLORS.soft};">Warmly,<br />The Reserve</p>
      `),
  };
}

/**
 * Touchpoint 3 — the cancellation notice (client communications, phase 4).
 * Fires when a client cancels through their link. One template, four
 * endings, chosen by the fee outcome the cancel route decided:
 *   outside_window — cancelled in time, nothing owed;
 *   waived         — late, first time: the lifetime waiver is now spent;
 *   charge         — late, the fee was charged to the card on file;
 *   uncollected    — late, no card on file: the fee is owed at the next visit.
 * The ending states plainly what happened to their money; that is the
 * whole point of the email, so it is never softened into "see policy".
 */
export function cancellationNoticeEmail(options: {
  clientFirstName: string;
  serviceName: string;
  staffName: string;
  startsAtIso: string;
  timezone: string;
  locationName: string;
  outcome: "outside_window" | "waived" | "charge" | "uncollected";
  /** The POLICY amount, not what was charged: the waived ending quotes it as the future fee. */
  feeCents: number;
  /** Last four digits of the card charged; only for outcome "charge". */
  cardLast4?: string | null;
}): { subject: string; html: string } {
  const when = whenLabel(options.startsAtIso, options.timezone);
  const fee = `$${(options.feeCents / 100).toFixed(2)}`;
  const ending = {
    outside_window: `
        <p style="margin:0 0 16px;">
          You cancelled with more than 24 hours' notice, so there is no
          charge. Thank you for letting us know early.
        </p>`,
    waived: `
        <p style="margin:0 0 16px;">
          This cancellation was within 24 hours of your appointment. As a
          courtesy, your first late cancellation has been waived, so there
          is no charge this time.
        </p>
        <p style="margin:0 0 16px;">
          Please note that this courtesy has now been used. Future late
          cancellations will incur a ${fee} fee.
        </p>`,
    charge: `
        <p style="margin:0 0 16px;">
          This cancellation was within 24 hours of your appointment, and
          your first late cancellation has already been waived, so the
          ${fee} late cancellation fee has been charged to your card on
          file${options.cardLast4 ? ` ending in ${options.cardLast4}` : ""}.
        </p>`,
    uncollected: `
        <p style="margin:0 0 16px;">
          This cancellation was within 24 hours of your appointment, and
          your first late cancellation has already been waived, so a ${fee}
          late cancellation fee applies. We do not have a card on file for
          you, so we will settle it with you at your next visit.
        </p>`,
  }[options.outcome];

  return {
    subject: `Your appointment on ${when} is cancelled`,
    html: shell(`
        <p style="margin:0 0 16px;">Hi ${options.clientFirstName},</p>
        <p style="margin:0 0 16px;">We have cancelled your appointment:</p>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
               style="background-color:${COLORS.cream};border-radius:8px;margin:8px 0 20px;">
          <tr><td style="padding:18px 20px;">
            <p style="margin:0 0 6px;font-size:16px;"><strong>${options.serviceName}</strong></p>
            <p style="margin:0 0 4px;color:${COLORS.soft};">${when}</p>
            <p style="margin:0 0 4px;color:${COLORS.soft};">with ${options.staffName}</p>
            <p style="margin:0;color:${COLORS.soft};">${options.locationName}</p>
          </td></tr>
        </table>
        ${ending}
        <p style="margin:0 0 16px;">
          Whenever you are ready to rebook, call us or ask at the front
          desk and we will find you a time.
        </p>
        <p style="margin:0;color:${COLORS.soft};">Warmly,<br />The Reserve</p>
      `),
  };
}
