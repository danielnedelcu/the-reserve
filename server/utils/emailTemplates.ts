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
}): { subject: string; html: string } {
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
            <p style="margin:0;color:${COLORS.soft};">with ${options.staffName}</p>
          </td></tr>
        </table>
        <p style="margin:0;font-size:13px;color:${COLORS.soft};">
          Need to reschedule? Please call us as early as possible so we can offer
          your time to another guest.
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
