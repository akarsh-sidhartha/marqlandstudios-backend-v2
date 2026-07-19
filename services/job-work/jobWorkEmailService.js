'use strict';
/**
 * services/jobWorkEmailService.js
 *
 * Dedicated invite email for Job Work vendors — kept separate from
 * services/emailService.js (whose sendInviteEmail() only branches between
 * 'employee' and 'supplier' copy/links) so that file doesn't need to be
 * touched. Reuses the same SMTP env vars (EMAIL_HOST/EMAIL_USER/EMAIL_PASS/
 * EMAIL_SERVICE/EMAIL_FROM) and visual style as the rest of the app's
 * transactional email.
 *
 * Link target: CLIENT_URL/job-work?token=... — the public site's Job Work
 * page (see marqlandstudios-client's src/pages/jobwork/JobWorkPage.js),
 * which verifies the token and shows the "create your password" form.
 */
const nodemailer = require('nodemailer');

const createTransporter = () => {
  if (process.env.EMAIL_SERVICE === 'gmail') {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
  }
  const host = process.env.EMAIL_HOST || 'smtp.office365.com';
  const port = parseInt(process.env.EMAIL_PORT || '587', 10);
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    tls: { rejectUnauthorized: false },
  });
};

/**
 * @param {string} toEmail
 * @param {string} inviteToken
 * @param {string} [inviterName]
 */
const sendJobWorkInviteEmail = async (toEmail, inviteToken, inviterName = 'The Marqland Admin') => {
  const transporter = createTransporter();
  const appUrl = process.env.CLIENT_URL || 'http://localhost:3001';
  const inviteLink = `${appUrl}/job-work?token=${inviteToken}`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || `Marqland Portal <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject: `You're invited to Marqland Studios' Job Work Portal`,
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
              <td style="padding-left:12px;color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.02em;text-transform:uppercase;">Marqland</td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 32px;">
            <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#1e293b;">You're invited! 🎉</h1>
            <p style="margin:0 0 24px;font-size:15px;color:#64748b;line-height:1.6;">
              <strong>${inviterName}</strong> has invited you to submit job work through the
              <strong>Marqland Studios Job Work Portal</strong>. Click below to set up your account.
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td style="background:#b8975a;border-radius:10px;">
                  <a href="${inviteLink}" style="display:inline-block;padding:14px 32px;color:#0f172a;text-decoration:none;font-size:15px;font-weight:700;">
                    Create My Account →
                  </a>
                </td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0" style="background:#fefce8;border:1px solid #fde047;border-radius:8px;margin-bottom:24px;width:100%;">
              <tr>
                <td style="padding:12px 16px;font-size:13px;color:#854d0e;">
                  ⏰ <strong>This link expires in 48 hours.</strong> After creating your password, an admin will grant portal access.
                </td>
              </tr>
            </table>
            <p style="font-size:12px;color:#94a3b8;line-height:1.6;margin:0;">
              If the button doesn't work, copy this link:<br/>
              <a href="${inviteLink}" style="color:#b8975a;word-break:break-all;">${inviteLink}</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 40px;">
            <p style="margin:0;font-size:12px;color:#94a3b8;">
              Sent by ${inviterName} via Marqland Studios. If unexpected, ignore this email.
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

module.exports = { sendJobWorkInviteEmail };
