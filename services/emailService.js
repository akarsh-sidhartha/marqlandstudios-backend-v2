const nodemailer = require('nodemailer');
const crypto     = require('crypto');

/**
 * backend/services/emailService.js
 *
 * Supports three email providers via .env:
 *
 * Option A — GoDaddy / Microsoft Exchange (current setup):
 *   EMAIL_HOST=smtp.office365.com
 *   EMAIL_PORT=587
 *   EMAIL_USER=info@marqland.com
 *   EMAIL_PASS=your_password
 *   EMAIL_FROM=Marqland Portal <info@marqland.com>
 *
 * Option B — Gmail:
 *   EMAIL_SERVICE=gmail
 *   EMAIL_USER=you@gmail.com
 *   EMAIL_PASS=your_16_char_app_password
 *
 * Option C — Any other SMTP:
 *   EMAIL_HOST=your.smtp.host
 *   EMAIL_PORT=587
 *   EMAIL_USER=...
 *   EMAIL_PASS=...
 */

const createTransporter = () => {
  if (process.env.EMAIL_SERVICE === 'gmail') {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }

  const host = process.env.EMAIL_HOST || 'smtp.office365.com';
  const port = parseInt(process.env.EMAIL_PORT || '587', 10);

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });
};

/**
 * ── Email threading helpers ────────────────────────────────────────────────
 * Gmail/Outlook thread messages using the Message-ID / In-Reply-To /
 * References headers — not subject-line matching. We generate our own
 * Message-ID (rather than letting nodemailer auto-assign a random one) so
 * we can persist it on the order and reference it again for every
 * subsequent reply in the thread.
 */
const MESSAGE_ID_DOMAIN = (process.env.EMAIL_USER || 'marqland.com').split('@').pop();
const generateMessageId = () => `<${crypto.randomUUID()}@${MESSAGE_ID_DOMAIN}>`;

/**
 * Test SMTP connection — call on server startup to catch misconfig early.
 */
const verifyEmailConfig = async () => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('⚠️  Email not configured — EMAIL_USER or EMAIL_PASS missing.');
    return false;
  }
  try {
    const transporter = createTransporter();
    await transporter.verify();
    console.log(`✅ Email configured — ${process.env.EMAIL_USER} via ${process.env.EMAIL_HOST || 'smtp.office365.com'}`);
    return true;
  } catch (err) {
    console.warn(`⚠️  Email connection failed: ${err.message}`);
    return false;
  }
};

/**
 * Send invite email.
 * inviteType: 'employee' (default) | 'supplier'
 *   - employee -> unchanged: Marqland Internal Portal copy, links to ADMIN_URL/#/invite?token=...
 *   - supplier -> Partner-facing copy, links to CLIENT_URL/partner?token=... (the public
 *     marqlandstudios.com site's Partner page, which has its own inline
 *     "complete your registration" form for the token — not the admin app).
 */
const sendInviteEmail = async (toEmail, inviteToken, inviterName = 'The Marqland Admin', inviteType = 'employee') => {
  const transporter = createTransporter();

  const isSupplier = inviteType === 'supplier';
  const appUrl = isSupplier
    ? (process.env.CLIENT_URL || 'http://localhost:3001')
    : (process.env.ADMIN_URL || 'http://localhost:3000');
  const inviteLink = isSupplier
    ? `${appUrl}/partner?token=${inviteToken}`
    : `${appUrl}/#/invite?token=${inviteToken}`;

  const heading = isSupplier
    ? `You're invited! 🎉`
    : `You're invited! 🎉`;
  const bodyCopy = isSupplier
    ? `<strong>Marqland Studios</strong> has invited you to join the <strong>Marqland Studios Family of Suppliers</strong>. Click the button below to set up your account.`
    : `<strong>${inviterName}</strong> has invited you to join the <strong>Marqland Internal Portal</strong>. Click the button below to set up your account.`;
  const subject = isSupplier
    ? `You're invited to join Marqland Studios' Family of Suppliers`
    : `You've been invited to Marqland Internal Portal`;
  const footerCopy = isSupplier
    ? `Sent by Marqland Studios. If unexpected, ignore this email.`
    : `Sent by ${inviterName} via Marqland Internal Portal. If unexpected, ignore this email.`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || `Marqland Portal <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject,
    html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#0f172a;padding:32px 40px;">
            <table cellpadding="0" cellspacing="0"><tr>
              <td style="background:#6366f1;width:36px;height:36px;border-radius:8px;text-align:center;vertical-align:middle;">
                <span style="color:#fff;font-size:18px;font-weight:900;">▦</span>
              </td>
              <td style="padding-left:12px;color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.02em;text-transform:uppercase;">Marqland</td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 32px;">
            <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#1e293b;">${heading}</h1>
            <p style="margin:0 0 24px;font-size:15px;color:#64748b;line-height:1.6;">
              ${bodyCopy}
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td style="background:#6366f1;border-radius:10px;">
                  <a href="${inviteLink}" style="display:inline-block;padding:14px 32px;color:#fff;text-decoration:none;font-size:15px;font-weight:700;">
                    Create My Account →
                  </a>
                </td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0" style="background:#fefce8;border:1px solid #fde047;border-radius:8px;margin-bottom:24px;width:100%;">
              <tr>
                <td style="padding:12px 16px;font-size:13px;color:#854d0e;">
                  ⏰ <strong>This link expires in 48 hours.</strong> After registering, an admin will activate your account.
                </td>
              </tr>
            </table>
            <p style="font-size:12px;color:#94a3b8;line-height:1.6;margin:0;">
              If the button doesn't work, copy this link:<br/>
              <a href="${inviteLink}" style="color:#6366f1;word-break:break-all;">${inviteLink}</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 40px;">
            <p style="margin:0;font-size:12px;color:#94a3b8;">
              ${footerCopy}
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
};

/**
 * Send a "we're unable to onboard you as a partner" notification, with the
 * admin's reason, when a Partner Lead is deleted/rejected from AdminView.js.
 */
const sendPartnerRejectionEmail = async ({ to, companyName, contactName, reason }) => {
  const transporter = createTransporter();

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || `Marqland Studios <${process.env.EMAIL_USER}>`,
    to,
    subject: `Update on your Marqland Studios Partner application`,
    html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#0f172a;padding:32px 40px;">
            <table cellpadding="0" cellspacing="0"><tr>
              <td style="background:#b8975a;width:36px;height:36px;border-radius:8px;text-align:center;vertical-align:middle;">
                <span style="color:#0f172a;font-size:18px;font-weight:900;">▦</span>
              </td>
              <td style="padding-left:12px;color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.02em;text-transform:uppercase;">Marqland Studios</td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 32px;">
            <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#1e293b;">Thank you for your interest${contactName ? `, ${contactName}` : ''}</h1>
            <p style="margin:0 0 20px;font-size:15px;color:#64748b;line-height:1.6;">
              We appreciate ${companyName ? `<strong>${companyName}</strong>` : 'you'} taking the time to apply to become a Marqland Studios
              partner supplier. After review, we're unable to move forward with onboarding at this time.
            </p>
            <table cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:24px;width:100%;">
              <tr>
                <td style="padding:16px 18px;font-size:13px;color:#334155;line-height:1.6;">
                  <strong>Note from our team:</strong><br/>${reason}
                </td>
              </tr>
            </table>
            <p style="font-size:13px;color:#64748b;line-height:1.6;margin:0;">
              We'd welcome a future application should your offering evolve. Thank you again for your interest in Marqland Studios.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 40px;">
            <p style="margin:0;font-size:12px;color:#94a3b8;">Marqland Studios — Partner Program</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
};

/**
 * Send password reset email.
 */
const sendPasswordResetEmail = async (toEmail, resetToken, userName = 'there', portal = 'employee') => {
  const transporter = createTransporter();
  const isClientPortal = portal === 'supplier' || portal === 'jobWork';
  const appUrl = isClientPortal
    ? (process.env.CLIENT_URL || 'http://localhost:3001')
    : (process.env.ADMIN_URL || 'http://localhost:3000');
  const resetLink = portal === 'supplier'
    ? `${appUrl}/partner?reset=${resetToken}`
    : portal === 'jobWork'
      ? `${appUrl}/job-work?reset=${resetToken}`
      : `${appUrl}/#/?reset=${resetToken}`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || `Marqland Portal <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject: 'Reset your Marqland Portal password',
    html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#0f172a;padding:32px 40px;">
            <table cellpadding="0" cellspacing="0"><tr>
              <td style="background:#6366f1;width:36px;height:36px;border-radius:8px;text-align:center;vertical-align:middle;">
                <span style="color:#fff;font-size:18px;font-weight:900;">▦</span>
              </td>
              <td style="padding-left:12px;color:#fff;font-size:20px;font-weight:800;text-transform:uppercase;">Marqland</td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 32px;">
            <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#1e293b;">Reset your password</h1>
            <p style="margin:0 0 24px;font-size:15px;color:#64748b;line-height:1.6;">
              Hi ${userName}, click below to set a new password.
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td style="background:#6366f1;border-radius:10px;">
                  <a href="${resetLink}" style="display:inline-block;padding:14px 32px;color:#fff;text-decoration:none;font-size:15px;font-weight:700;">
                    Reset Password →
                  </a>
                </td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0" style="background:#fefce8;border:1px solid #fde047;border-radius:8px;margin-bottom:24px;width:100%;">
              <tr>
                <td style="padding:12px 16px;font-size:13px;color:#854d0e;">
                  ⏰ <strong>This link expires in 1 hour.</strong> If you didn't request this, ignore this email.
                </td>
              </tr>
            </table>
            <p style="font-size:12px;color:#94a3b8;margin:0;">
              Or copy: <a href="${resetLink}" style="color:#6366f1;word-break:break-all;">${resetLink}</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 40px;">
            <p style="margin:0;font-size:12px;color:#94a3b8;">Marqland Internal Portal.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
};

/**
 * Send client portal link email.
 *
 * Called by POST /api/portal/send-email after a new order is created.
 *
 * @param {object} opts
 * @param {string} opts.toEmail       - Client's email address (TO)
 * @param {string} opts.contactName   - Contact person's name (e.g. "John Doe")
 * @param {string} opts.clientName    - Company name (e.g. "Acme Corp")
 * @param {string} opts.orderRef      - Inquiry ref number (e.g. "INQ-26-27-002")
 * @param {string} opts.title         - Project title
 * @param {string} opts.portalUrl     - Full portal URL (e.g. "https://app.marqland.com/p/uk2al-inq-26-27-002")
 * @param {string} [opts.cc]          - Optional CC address (defaults to info@marqland.com)
 *
 * @returns {Promise<{messageId: string, subject: string}>}
 *   The Message-ID and subject used for THIS send. The caller (the
 *   /api/portal/send-email route) must persist these on the order's
 *   `emailThread` field — they're the anchor every later timeline-update
 *   email threads off of.
 */
const sendPortalEmail = async ({ slug, clientEmail, contactName, clientName, orderRef, title, portalUrl, cc }) => {
  const transporter = createTransporter();
  const ccAddress = cc || process.env.PORTAL_CC_EMAIL || 'info@marqland.com';
  const firstName = (contactName || '').split(' ')[0] || 'there';
  const subject   = `Your Project Portal — ${orderRef}: ${title}`;
  const messageId = generateMessageId();

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || `Marqland Portal <${process.env.EMAIL_USER}>`,
    to: clientEmail,
    cc: ccAddress,   // ← always CC info@marqland.com
    subject,
    messageId,        // ← nodemailer sets the Message-ID header to exactly this value
    html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Project Curated Successfully</title>
</head>
<body style="margin:0;padding:0;background-color:#faf8f5;font-family:'Manrope', 'Segoe UI', system-ui, sans-serif;color:#1a1a1a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;background-color:#faf8f5;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border:1px solid rgba(0,0,0,0.06);border-radius:0px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.05);">

          <!-- Premium Navy Header Bar -->
          <tr>
            <td style="background-color:#0e1520;padding:32px 40px;border-bottom:1px solid rgba(255,255,255,0.05);">
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td width="28" style="background-color:#b8975a;width:28px;height:28px;border-radius:6px;text-align:center;vertical-align:middle;font-family:'Jost',sans-serif;font-weight:900;color:#0e1520;font-size:13px;">
                    M
                  </td>
                  <td style="padding-left:12px;color:#ffffff;font-size:16px;font-weight:400;font-family:'Jost', sans-serif;letter-spacing:0.2em;text-transform:uppercase;">
                    Marqland Studios
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Tonal Reference Bar Section -->
          <tr>
            <td style="background-color:#f2efe9;padding:12px 40px;border-bottom:1px solid rgba(0,0,0,0.05);">
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <span style="color:rgba(26,26,26,0.4);font-family:'Jost',sans-serif;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.25em;">Reference</span>
                    &nbsp;&nbsp;
                    <span style="color:#b8975a;font-family:'Jost',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;">${orderRef}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Body Copy Section -->
          <tr>
            <td style="padding:44px 40px 32px;">
              <h1 style="margin:0 0 16px;font-family:'Cormorant Garamond', Georgia, serif;font-size:28px;font-weight:300;color:#1a1a1a;line-height:1.2;">
                Curated for <span style="color:#b8975a;font-style:italic;">${firstName},</span>
              </h1>
              <p style="margin:0 0 14px;font-size:14px;color:rgba(26,26,26,0.65);line-height:1.75;font-weight:400;">
                Your project <strong style="color:#1a1a1a;font-weight:600;">${title}</strong> has been curated by our project team.
              </p>
              <p style="margin:0 0 36px;font-size:14px;color:rgba(26,26,26,0.65);line-height:1.75;font-weight:400;">
                Your tailored digital concierge workspace is online. Use this portal to review options, interact live on our message boards and track dispatch milestones seamlessly.
              </p>

              <!-- Luxury Gold CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 0 40px;">
                <tr>
                  <td style="background-color:#b8975a;border-radius:0px;">
                    <a href="${portalUrl}"
                       style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg, #d4b06a, #b8975a);color:#0e1520;text-decoration:none;font-family:'Jost',sans-serif;font-size:10px;font-weight:500;letter-spacing:0.25em;text-transform:uppercase;box-shadow:0 4px 16px rgba(184,151,90,0.25);">
                      Open Project Workspace →
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Minimal Layered Info Box Section -->
              <table cellpadding="0" cellspacing="0" style="background-color:#fff;border:1px solid rgba(0,0,0,0.07);width:100%;margin-bottom:32px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <table cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="font-family:'Jost',sans-serif;font-size:9px;font-weight:500;color:rgba(26,26,26,0.4);text-transform:uppercase;letter-spacing:0.2em;padding-bottom:14px;">
                          Project Overview
                        </td>
                      </tr>
                      <tr>
                        <td style="font-family:'Jost',sans-serif;font-size:13px;color:#1a1a1a;padding-bottom:8px;font-weight:400;">
                          <span style="color:rgba(26,26,26,0.45);">Client:</span> &nbsp;${clientName}
                        </td>
                      </tr>
                      <tr>
                        <td style="font-family:'Jost',sans-serif;font-size:13px;color:#1a1a1a;padding-bottom:8px;font-weight:400;">
                          <span style="color:rgba(26,26,26,0.45);">Concierge Liaison:</span> &nbsp;${contactName}
                        </td>
                      </tr>
                      <tr>
                        <td style="font-family:'Jost',sans-serif;font-size:13px;color:#1a1a1a;font-weight:400;">
                          <span style="color:rgba(26,26,26,0.45);">Assignment Focus:</span> &nbsp;<span style="color:#b8975a;font-weight:500;">${title}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Fallback Token Link Footer Block -->
              <p style="font-family:'Jost',sans-serif;font-size:11px;color:rgba(26,26,26,0.4);line-height:1.6;margin:0;font-weight:300;letter-spacing:0.02em;">
                If your client doesn't resolve the button correctly, access securely via your browser:<br/>
                <a href="${portalUrl}" style="color:#b8975a;word-break:break-all;text-decoration:none;font-weight:400;">${portalUrl}</a>
              </p>
            </td>
          </tr>

          <!-- Tonal Studio Footer -->
          <tr>
            <td style="background-color:#ffffff;border-top:1px solid rgba(0,0,0,0.06);padding:24px 40px;text-align:center;">
              <p style="margin:0;font-family:'Jost',sans-serif;font-size:11px;color:rgba(26,26,26,0.4);line-height:1.6;letter-spacing:0.03em;">
                This secure distribution update was processed automatically by Marqland Studios.<br/>
                Confidentiality Notice: This document contains proprietary client content. If encountered unexpectedly, please notify <a href="mailto:info@marqland.com" style="color:#b8975a;text-decoration:none;">info@marqland.com</a>.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  });

  return { messageId, subject };
};

/**
 * Send a threaded timeline-update email — a reply in the SAME thread as the
 * original portal email (see sendPortalEmail above).
 *
 * Threading is driven by headers, not by the subject line:
 *   - Message-ID   — unique ID for THIS email (generated fresh each send)
 *   - In-Reply-To  — Message-ID of the email being replied to (the previous
 *                    one in the chain, or the original if this is the first reply)
 *   - References   — the full chain of every prior Message-ID, oldest → newest,
 *                    space-separated. Gmail in particular relies on this to
 *                    stitch the whole conversation together.
 *
 * The subject is kept byte-for-byte identical to the original (with a
 * cosmetic "Re: " prefix) so the thread also *looks* like one conversation
 * in the client's UI, even though the headers are what actually thread it.
 *
 * @param {object} opts
 * @param {string} opts.clientEmail  - Client's email address (TO)
 * @param {string} [opts.cc]         - Optional CC address (defaults to info@marqland.com)
 * @param {string} opts.subject      - The ORIGINAL email's subject (from order.emailThread.subject)
 * @param {string} opts.inReplyTo    - Message-ID of the immediately preceding email in the thread
 * @param {string} opts.references   - Space-separated chain of every prior Message-ID
 * @param {string} opts.contactName  - Contact person's name
 * @param {string} opts.clientName   - Company name
 * @param {string} opts.orderRef     - Inquiry/quote ref number
 * @param {string} opts.title        - Project title
 * @param {string} opts.status       - Timeline event status (inquiry | ongoing | completed | update)
 * @param {string} opts.message      - The update message body
 * @param {string} [opts.portalUrl]  - Optional portal link to include in the email
 *
 * @returns {Promise<{messageId: string}>}
 *   The Message-ID used for THIS send — the caller must append it to
 *   order.emailThread.references so the NEXT update can chain off of it.
 */
const sendTimelineUpdateEmail = async ({
  clientEmail, cc, subject, inReplyTo, references,
  contactName, clientName, orderRef, title, status, message, portalUrl,
}) => {
  const transporter = createTransporter();
  const ccAddress = cc || process.env.PORTAL_CC_EMAIL || 'info@marqland.com';
  const firstName = (contactName || '').split(' ')[0] || 'there';
  const messageId = generateMessageId();
  const replySubject = subject?.trim().toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`;

  const STATUS_LABELS = {
    inquiry: 'Inquiry Received', ongoing: 'In Production', completed: 'Completed', update: 'Update',
  };

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || `Marqland Portal <${process.env.EMAIL_USER}>`,
    to: clientEmail,
    cc: ccAddress,
    subject: replySubject,
    messageId,
    inReplyTo,   // nodemailer wraps this in <> automatically if needed
    references,  // space-separated string — nodemailer passes it through as-is
    html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Project Update</title>
</head>
<body style="margin:0;padding:0;background-color:#faf8f5;font-family:'Manrope', 'Segoe UI', system-ui, sans-serif;color:#1a1a1a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;background-color:#faf8f5;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border:1px solid rgba(0,0,0,0.06);border-radius:0px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.05);">

          <!-- Premium Navy Header Bar -->
          <tr>
            <td style="background-color:#0e1520;padding:32px 40px;border-bottom:1px solid rgba(255,255,255,0.05);">
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td width="28" style="background-color:#b8975a;width:28px;height:28px;border-radius:6px;text-align:center;vertical-align:middle;font-family:'Jost',sans-serif;font-weight:900;color:#0e1520;font-size:13px;">
                    M
                  </td>
                  <td style="padding-left:12px;color:#ffffff;font-size:16px;font-weight:400;font-family:'Jost', sans-serif;letter-spacing:0.2em;text-transform:uppercase;">
                    Marqland Studios
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Tonal Reference Bar Section -->
          <tr>
            <td style="background-color:#f2efe9;padding:12px 40px;border-bottom:1px solid rgba(0,0,0,0.05);">
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <span style="color:rgba(26,26,26,0.4);font-family:'Jost',sans-serif;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.25em;">Reference</span>
                    &nbsp;&nbsp;
                    <span style="color:#b8975a;font-family:'Jost',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;">${orderRef}</span>
                    &nbsp;&nbsp;&nbsp;
                    <span style="color:rgba(26,26,26,0.4);font-family:'Jost',sans-serif;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.25em;">Status</span>
                    &nbsp;&nbsp;
                    <span style="color:#0e1520;font-family:'Jost',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;">${STATUS_LABELS[status] || status}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Body Copy Section -->
          <tr>
            <td style="padding:44px 40px 32px;">
              <h1 style="margin:0 0 16px;font-family:'Cormorant Garamond', Georgia, serif;font-size:28px;font-weight:300;color:#1a1a1a;line-height:1.2;">
                Update for <span style="color:#b8975a;font-style:italic;">${firstName},</span>
              </h1>
              <p style="margin:0 0 14px;font-size:14px;color:rgba(26,26,26,0.65);line-height:1.75;font-weight:400;">
                There's a new update on <strong style="color:#1a1a1a;font-weight:600;">${title}</strong>.
              </p>

              <!-- Update message box -->
              <table cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid rgba(0,0,0,0.06);width:100%;margin-bottom:32px;">
                <tr>
                  <td style="padding:20px 24px;font-family:'Jost',sans-serif;font-size:14px;color:#1a1a1a;line-height:1.75;font-weight:400;">
                    ${message}
                  </td>
                </tr>
              </table>

              ${portalUrl ? `
              <!-- Luxury Gold CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 0 36px;">
                <tr>
                  <td style="background-color:#b8975a;border-radius:0px;">
                    <a href="${portalUrl}"
                       style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg, #d4b06a, #b8975a);color:#0e1520;text-decoration:none;font-family:'Jost',sans-serif;font-size:10px;font-weight:500;letter-spacing:0.25em;text-transform:uppercase;box-shadow:0 4px 16px rgba(184,151,90,0.25);">
                      Open Project Workspace →
                    </a>
                  </td>
                </tr>
              </table>` : ''}

              <!-- Minimal Layered Info Box Section -->
              <table cellpadding="0" cellspacing="0" style="background-color:#fff;border:1px solid rgba(0,0,0,0.07);width:100%;margin-bottom:8px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <table cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="font-family:'Jost',sans-serif;font-size:13px;color:#1a1a1a;padding-bottom:8px;font-weight:400;">
                          <span style="color:rgba(26,26,26,0.45);">Client:</span> &nbsp;${clientName}
                        </td>
                      </tr>
                      <tr>
                        <td style="font-family:'Jost',sans-serif;font-size:13px;color:#1a1a1a;font-weight:400;">
                          <span style="color:rgba(26,26,26,0.45);">Concierge Liaison:</span> &nbsp;${contactName}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Tonal Studio Footer -->
          <tr>
            <td style="background-color:#ffffff;border-top:1px solid rgba(0,0,0,0.06);padding:24px 40px;text-align:center;">
              <p style="margin:0;font-family:'Jost',sans-serif;font-size:11px;color:rgba(26,26,26,0.4);line-height:1.6;letter-spacing:0.03em;">
                This secure distribution update was processed automatically by Marqland Studios.<br/>
                Confidentiality Notice: This document contains proprietary client content. If encountered unexpectedly, please notify <a href="mailto:info@marqland.com" style="color:#b8975a;text-decoration:none;">info@marqland.com</a>.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  });

  return { messageId };
};

module.exports = {
  sendInviteEmail,
  sendPartnerRejectionEmail,
  sendPasswordResetEmail,
  sendPortalEmail,
  sendTimelineUpdateEmail,
  verifyEmailConfig,
};