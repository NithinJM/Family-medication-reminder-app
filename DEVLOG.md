# MedVigil Development Log

This file records the current product behavior and notable implementation decisions for the Family Medication Reminder (FMR) project. It intentionally excludes credentials, tokens, and patient data.

## 2026-10-23 — Current implementation

### Product experience

- The public landing page introduces MedVigil before a user signs in.
- Seniors and caregivers have separate login and registration pages.
- The senior routine uses Morning, Afternoon, and Evening groups with large type and clear **Taken** / **Not taken** actions.
- Caregivers can view medication names, dosages, scheduled times, adherence history, and alerts.
- Caregivers can switch to a read-only senior view preview. Senior accounts do not see this switch.
- A verified caregiver can create the family profile and medication plan before the senior joins. Seniors enter the caregiver’s invite code and can access family details only after both roles verify their email.

### Authentication and data

- Express serves the frontend and API; MongoDB with Mongoose stores accounts, families, medications, dose logs, and care alerts.
- Sessions are stored in MongoDB. Passwords are bcrypt-hashed, and email verification and password reset tokens are stored as hashes.
- Caregiver and senior registration, sign-in, email verification, logout, and role-specific password reset flows are implemented.
- The caregiver can save the family member’s name before the senior account is created.
- Medication status updates are accepted from senior accounts. Caregiver preview controls are disabled.

### Caregiver alerts

- The server checks active medications once per minute.
- A senior marking a dose **Not taken** creates an alert and triggers an immediate email attempt to verified caregivers.
- A dose with no check-in 30 minutes after its scheduled time creates an alert and triggers an email attempt.
- Alerts are stored in MongoDB even when email delivery is not configured or fails.
- The sender uses `EMAIL_FROM`, or defaults to the configured SMTP account with the MedVigil display name.
- SMTP supports a Gmail App Password or Google OAuth2. SMTP values must be configured in the local `.env`; this log never stores them.

## Project structure

| File | Responsibility |
| --- | --- |
| `server.js` | Express server, MongoDB models, authentication, API routes, email, and scheduled alerts |
| `index.html` | Medication dashboard and senior routine markup |
| `app.js` | Dashboard rendering, senior actions, caregiver preview, history, and API calls |
| `styles.css` | Dashboard and senior view styling |
| `welcome.html`, `welcome.js`, `landing.css` | Public landing and verification status experience |
| `caregiver-login.html`, `senior-login.html` | Role-specific login, registration, and account recovery screens |
| `auth.js`, `login.css` | Shared authentication and password reset behavior and styling |
| `README.md` | Setup instructions, account flow, email configuration, and API reference |

## Run and configure

- Install Node.js 18 or newer and MongoDB.
- Copy `.env.example` to `.env`; set the MongoDB connection, session secret, base URL, and valid SMTP credentials for email delivery.
- Start with `npm start` or use `npm run dev` during development.
- In local development without SMTP, verification/reset links are written to the server terminal. Email alerts still require working SMTP credentials.

## Follow-up work

- Add explicit patient time-zone handling for scheduled medication times.
- Add delivery retries and monitoring for caregiver email alerts.
- Add audit logging and review deployment hardening and privacy controls before storing real patient information.
- Consider verified invitations for additional family members.

