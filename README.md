# MedVigil Family Medication Reminder

A responsive medication routine and caregiver dashboard. The senior view groups doses into Morning, Afternoon, and Evening and offers large Taken / Not taken buttons. Caregiver updates refresh every 15 seconds, with daily and seven-day dose history.

The default page is a public app overview. After email verification, a caregiver can sign in first, name the family member, and enter their medication schedule before the senior joins. The caregiver receives a family invite code at registration; the senior enters it when creating their account. Senior access to family medication details remains gated until both roles in the family have verified their email addresses.

## Run locally

1. Install Node.js 18 or newer and MongoDB.
2. Copy `.env.example` to `.env`; set `MONGODB_URI`, a long random `SESSION_SECRET`, and the public `BASE_URL`.
3. For Gmail, keep `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, and `SMTP_SECURE=false`; set `SMTP_USER` to the full Google account email. For OAuth2, set `SMTP_AUTH=oauth2` and provide `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` from a Google OAuth client authorized with the `https://mail.google.com/` scope. Otherwise, set `SMTP_AUTH=password` and use a 16-character Google App Password in `SMTP_PASS` (not the regular password). `EMAIL_FROM` is optional and defaults to the SMTP sender.
4. Run `npm install`, then `npm start`.
5. Open `http://localhost:3000`.

In local development, if SMTP is not configured, verification links are printed in the server terminal and shown on the registration page; password reset links are printed in the server terminal. In production, registration is disabled until SMTP is configured. MongoDB is required for accounts, sessions, family membership, and medication records. Gmail App Passwords require 2-Step Verification on the Google account. See [Google's Gmail SMTP OAuth documentation](https://developers.google.com/workspace/gmail/imap/imap-smtp) and [Nodemailer's OAuth2 setup](https://nodemailer.com/smtp/oauth2) for OAuth client and refresh-token setup.

## Email account flow

- `caregiver-login.html` offers caregiver sign-in and account creation. Creating a caregiver account creates a family and an invite code to share with the senior.
- `senior-login.html` offers senior sign-in and account creation. A senior must enter the caregiver’s family invite code.
- Each account receives a 24-hour verification link. A verified caregiver can set up the family profile and medication schedule before the senior joins. The senior can access family medication records only after both roles have verified their email and signed in.
- Session cookies are HTTP-only and stored in MongoDB. Passwords are bcrypt-hashed; verification and password reset tokens are stored as hashes. Password reset links expire after one hour and can only be used once; resetting a password signs out existing sessions.

## Escalation

All active medications are checked once per minute by the server. If a senior marks a dose Not taken, MedVigil creates a caregiver alert and sends an email immediately. If there is no dose check-in within 30 minutes after its scheduled time, the server creates an alert and emails the verified caregiver account. Messages use the MedVigil sender configured by `EMAIL_FROM` (or default to the SMTP account). Configure SMTP in `.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS`). Without valid SMTP credentials, alerts still appear in the dashboard but email delivery is unavailable.

## API

- `GET /api/health` — server and database status.
- `POST /api/auth/register` — create a senior or caregiver account and send verification email.
- `POST /api/auth/login` — sign in after email verification.
- `POST /api/auth/resend-verification` — issue a replacement email verification link.
- `POST /api/auth/request-password-reset` — request a role-specific password reset email.
- `POST /api/auth/reset-password` — set a new password using a one-hour, single-use reset token.
- `GET /auth/verify?token=...` — verify an email address.
- `GET /api/auth/me` — return the signed-in account’s verification and family-pairing status.
- `PUT /api/family/profile` — save the caregiver’s family member name before the senior joins.
- `POST /api/auth/logout` — end the current session.
- `GET /api/dashboard?date=YYYY-MM-DD` — medication status, caregiver alerts, and recent check-ins.
- `GET /api/history?days=7&date=YYYY-MM-DD` — daily dose history (up to seven days).
- `POST /api/medications` — add a medication (`name`, `dose`, `time`, optional `note`, `critical`).
- `POST /api/medications/:id/status` — log `taken` or `not_taken` (`recordedAt` and `scheduledFor` are optional).

Before storing real patient information, add verified caregiver invitations for additional family members, an explicit patient time zone, deployment hardening, audit logging, delivery retries and monitoring for email, and a reviewed privacy/security design. Email alerts require working SMTP credentials.
