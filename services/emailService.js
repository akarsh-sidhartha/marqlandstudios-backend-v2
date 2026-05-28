const nodemailer = require('nodemailer');

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
 * Send employee invite email.
 */
const sendInviteEmail = async (toEmail, inviteToken, inviterName = 'The Marqland Admin') => {
  const transporter = createTransporter();
  const appUrl      = process.env.ADMIN_URL || 'http://localhost:3000';
  const inviteLink  = `${appUrl}/#/invite?token=${inviteToken}`;

  await transporter.sendMail({
    from:    process.env.EMAIL_FROM || `Marqland Portal <${process.env.EMAIL_USER}>`,
    to:      toEmail,
    subject: `You've been invited to Marqland Internal Portal`,
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
            <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#1e293b;">You're invited! 🎉</h1>
            <p style="margin:0 0 24px;font-size:15px;color:#64748b;line-height:1.6;">
              <strong>${inviterName}</strong> has invited you to join the <strong>Marqland Internal Portal</strong>.
              Click the button below to set up your account.
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
              Sent by ${inviterName} via Marqland Internal Portal. If unexpected, ignore this email.
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
 * Send password reset email.
 */
const sendPasswordResetEmail = async (toEmail, resetToken, userName = 'there') => {
  const transporter = createTransporter();
  const appUrl      = process.env.ADMIN_URL || 'http://localhost:3000';
  const resetLink   = `${appUrl}/#/?reset=${resetToken}`;

  await transporter.sendMail({
    from:    process.env.EMAIL_FROM || `Marqland Portal <${process.env.EMAIL_USER}>`,
    to:      toEmail,
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
 */
const sendPortalEmail = async ({ slug, clientEmail, contactName, clientName, orderRef, title, portalUrl, cc }) => {
  const transporter = createTransporter();
  const ccAddress   = cc || process.env.PORTAL_CC_EMAIL || 'info@marqland.com';
  const firstName   = (contactName || '').split(' ')[0] || 'there';

  await transporter.sendMail({
    from:    process.env.EMAIL_FROM || `Marqland Portal <${process.env.EMAIL_USER}>`,
    to:      clientEmail,
    cc:      ccAddress,   // ← always CC info@marqland.com
    subject: `Your Project Portal — ${orderRef}: ${title}`,
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
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#0f172a;padding:28px 40px;">
            <table cellpadding="0" cellspacing="0"><tr>
              <td style="background:#6366f1;width:36px;height:36px;border-radius:8px;text-align:center;vertical-align:middle;">
                <span style="color:#fff;font-size:18px;font-weight:900;">▦</span>
              </td>
              <td style="padding-left:12px;color:#ffffff;font-size:20px;font-weight:800;letter-spacing:-0.02em;text-transform:uppercase;">Marqland</td>
            </tr></table>
          </td>
        </tr>

        <!-- Ref badge -->
        <tr>
          <td style="background:#6366f1;padding:10px 40px;">
            <span style="color:#c7d2fe;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Reference</span>
            &nbsp;
            <span style="color:#ffffff;font-size:13px;font-weight:800;letter-spacing:0.04em;">${orderRef}</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px 28px;">
            <h1 style="margin:0 0 6px;font-size:22px;font-weight:800;color:#1e293b;line-height:1.3;">
              Hi ${firstName},
            </h1>
            <p style="margin:0 0 6px;font-size:15px;color:#64748b;line-height:1.6;">
              Your project <strong style="color:#1e293b;">${title}</strong> has been received by <strong>Marqland</strong>.
            </p>
            <p style="margin:0 0 28px;font-size:15px;color:#64748b;line-height:1.6;">
              Use your private portal to track progress, review updates, and communicate with our team.
            </p>

            <!-- CTA button -->
            <table cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
              <tr>
                <td style="background:#6366f1;border-radius:10px;">
                  <a href="${portalUrl}"
                     style="display:inline-block;padding:15px 36px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;letter-spacing:0.01em;">
                    View My Project Portal →
                  </a>
                </td>
              </tr>
            </table>

            <!-- Info box -->
            <table cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;width:100%;margin-bottom:28px;">
              <tr>
                <td style="padding:18px 20px;">
                  <table cellpadding="0" cellspacing="0" width="100%">
                    <tr>
                      <td style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:10px;">
                        Project Details
                      </td>
                    </tr>
                    <tr>
                      <td style="font-size:13px;color:#475569;padding-bottom:6px;">
                        <strong style="color:#1e293b;">Client:</strong> &nbsp;${clientName}
                      </td>
                    </tr>
                    <tr>
                      <td style="font-size:13px;color:#475569;padding-bottom:6px;">
                        <strong style="color:#1e293b;">Contact:</strong> &nbsp;${contactName}
                      </td>
                    </tr>
                    <tr>
                      <td style="font-size:13px;color:#475569;">
                        <strong style="color:#1e293b;">Project:</strong> &nbsp;${title}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- Fallback link -->
            <p style="font-size:12px;color:#94a3b8;line-height:1.6;margin:0;">
              If the button doesn't work, copy this link into your browser:<br/>
              <a href="${portalUrl}" style="color:#6366f1;word-break:break-all;">${portalUrl}</a>
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:18px 40px;">
            <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.5;">
              This email was sent by Marqland on behalf of your project team.
              If you weren't expecting this, please contact us at
              <a href="mailto:info@marqland.com" style="color:#6366f1;">info@marqland.com</a>.
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

module.exports = {
  sendInviteEmail,
  sendPasswordResetEmail,
  sendPortalEmail,
  verifyEmailConfig,
};