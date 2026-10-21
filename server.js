require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const nodemailer = require('nodemailer');
const { rateLimit } = require('express-rate-limit');

const app = express();
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) throw new Error('SESSION_SECRET is required in production.');
const sessionStore = process.env.MONGODB_URI
  ? MongoStore.create({ mongoUrl: process.env.MONGODB_URI, collectionName: 'sessions', ttl: 60 * 60 * 24 })
  : undefined;
app.use(session({
  name: 'kindred.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 }
}));

const accountSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, required: true, enum: ['senior', 'caregiver'] },
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true },
  sessionVersion: { type: Number, default: 0 },
  emailVerifiedAt: { type: Date, default: null },
  verificationTokenHash: { type: String, select: false },
  verificationExpiresAt: { type: Date, select: false },
  passwordResetTokenHash: { type: String, select: false },
  passwordResetExpiresAt: { type: Date, select: false }
}, { timestamps: true });
const Account = mongoose.model('Account', accountSchema);
const familySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  seniorName: { type: String, trim: true, maxlength: 80, default: '' },
  inviteCode: { type: String, required: true, unique: true, select: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null }
}, { timestamps: true });
const Family = mongoose.model('Family', familySchema);
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

const medicationSchema = new mongoose.Schema({
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  dose: { type: String, required: true, trim: true, maxlength: 100 },
  time: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  note: { type: String, trim: true, maxlength: 120, default: 'as directed' },
  icon: { type: String, default: '✧' },
  color: { type: String, enum: ['sun', 'blue', 'lavender', 'peach'], default: 'lavender' },
  critical: { type: Boolean, default: false },
  active: { type: Boolean, default: true }
}, { timestamps: true });

const doseLogSchema = new mongoose.Schema({
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true },
  medicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medication', required: true },
  scheduledFor: { type: Date, required: true },
  status: { type: String, enum: ['taken', 'not_taken', 'missed'], required: true },
  recordedAt: { type: Date, required: true, default: Date.now },
  recordedBy: { type: String, trim: true, default: 'Eleanor Parker' }
}, { timestamps: true });
doseLogSchema.index({ medicationId: 1, scheduledFor: 1 }, { unique: true, partialFilterExpression: { scheduledFor: { $type: 'date' } } });

const alertSchema = new mongoose.Schema({
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true },
  medicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medication', required: true },
  medicationName: { type: String, required: true },
  scheduledFor: { type: Date, required: true },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  readAt: { type: Date, default: null },
  resolvedAt: { type: Date, default: null },
  emailStatus: { type: String, default: 'not_configured' }
}, { timestamps: true });
alertSchema.index({ medicationId: 1, scheduledFor: 1 }, { unique: true });

const Medication = mongoose.model('Medication', medicationSchema);
const DoseLog = mongoose.model('DoseLog', doseLogSchema);
const CareAlert = mongoose.model('CareAlert', alertSchema);

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function databaseRequired(res) {
  if (mongoose.connection.readyState === 1) return false;
  res.status(503).json({ error: 'Account services need a configured MongoDB connection.' });
  return true;
}
function smtpHost() { return String(process.env.SMTP_HOST || '').trim(); }
function smtpUser() { return String(process.env.SMTP_USER || '').trim(); }
function smtpPassword() { return String(process.env.SMTP_PASS || '').replace(/\s/g, ''); }
function smtpUsesGoogleOAuth() { return String(process.env.SMTP_AUTH || '').trim().toLowerCase() === 'oauth2'; }
function smtpReady() {
  const host = smtpHost();
  const user = smtpUser();
  if (!host || !user) return false;
  if (host.toLowerCase() === 'smtp.gmail.com') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) return false;
    if (smtpUsesGoogleOAuth()) return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim() && process.env.GOOGLE_REFRESH_TOKEN?.trim());
    return smtpPassword().length === 16;
  }
  return smtpUsesGoogleOAuth()
    ? Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim() && process.env.GOOGLE_REFRESH_TOKEN?.trim())
    : Boolean(smtpPassword());
}
function createSmtpTransport() {
  const auth = smtpUsesGoogleOAuth()
    ? { type: 'OAuth2', user: smtpUser(), clientId: process.env.GOOGLE_CLIENT_ID.trim(), clientSecret: process.env.GOOGLE_CLIENT_SECRET.trim(), refreshToken: process.env.GOOGLE_REFRESH_TOKEN.trim() }
    : { user: smtpUser(), pass: smtpPassword() };
  return nodemailer.createTransport({
    host: smtpHost(),
    port: Number(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE).trim().toLowerCase() === 'true',
    auth
  });
}
function emailSender() { return process.env.EMAIL_FROM?.trim() || `MedVigil <${smtpUser()}>`; }
function verificationLink(token) {
  const base = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  return `${base}/auth/verify?token=${encodeURIComponent(token)}`;
}
async function sendVerificationEmail(account, token, familyCode) {
  const url = verificationLink(token);
  if (!smtpReady()) {
    console.log(`Email verification for ${account.email}: ${url}`);
    return { sent: false, url };
  }
  const transport = createSmtpTransport();
  try {
    await transport.sendMail({
      from: emailSender(),
      to: account.email,
      subject: 'Verify your MedVigil email',
      text: `Hi ${account.name},\n\nPlease verify your email to access your MedVigil family space: ${url}\n${familyCode ? `\nFamily invite code for the senior member: ${familyCode}\n` : ''}\nThis link expires in 24 hours. If you did not create this account, ignore this message.`,
      html: `<p>Hi ${escapeHtml(account.name)},</p><p>Please verify your email to access your MedVigil family space.</p><p><a href="${url}">Verify my email</a></p>${familyCode ? `<p>Family invite code for the senior member: <strong>${escapeHtml(familyCode)}</strong></p>` : ''}<p>This link expires in 24 hours. If you did not create this account, ignore this message.</p>`
    });
  } catch (error) {
    if (process.env.NODE_ENV === 'production') throw error;
    console.error('SMTP delivery failed in development:', error.message);
    console.log(`Email verification for ${account.email}: ${url}`);
    return { sent: false, url };
  }
  return { sent: true };
}
function caregiverInviteLink(familyCode) {
  const base = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  return `${base}/caregiver-login.html?familyCode=${encodeURIComponent(familyCode)}`;
}
async function sendCaregiverInviteEmail(email, inviterName, familyCode) {
  const url = caregiverInviteLink(familyCode);
  if (!smtpReady()) {
    if (process.env.NODE_ENV === 'production') throw new Error('Email invitations are temporarily unavailable. Please try again later.');
    console.log(`Caregiver invitation for ${email}: ${url}`);
    return { sent: false, url };
  }
  await createSmtpTransport().sendMail({
    from: emailSender(), to: email, subject: `${inviterName} invited you to a MedVigil family`,
    text: `Hi,\n\n${inviterName} invited you to join their MedVigil family care circle as a caregiver. Create your caregiver account with this link: ${url}\n\nYou will need to verify your email before family details are available.`,
    html: `<p>Hi,</p><p>${escapeHtml(inviterName)} invited you to join their MedVigil family care circle as a caregiver.</p><p><a href="${escapeHtml(url)}">Accept caregiver invitation</a></p><p>You will need to verify your email before family details are available.</p>`
  });
  return { sent: true, url };
}
async function sendPasswordResetEmail(account, token) {
  const base = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const url = `${base}/${account.role}-login.html?reset=${encodeURIComponent(token)}`;
  if (!smtpReady()) {
    if (process.env.NODE_ENV !== 'production') console.log(`Password reset link for ${account.email}: ${url}`);
    return false;
  }
  const transport = createSmtpTransport();
  await transport.sendMail({
    from: emailSender(),
    to: account.email,
    subject: 'Reset your MedVigil password',
    text: `Hi ${account.name},\n\nUse this link to choose a new MedVigil password: ${url}\n\nThe link expires in one hour and can only be used once. If you did not request this, you can ignore this email.`,
    html: `<p>Hi ${escapeHtml(account.name)},</p><p>Use the link below to choose a new MedVigil password. It expires in one hour and can only be used once.</p><p><a href="${url}">Reset my password</a></p><p>If you did not request this, you can ignore this email.</p>`
  });
  return true;
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
async function familyIsReady(familyId) {
  if (!familyId) return false;
  const [senior, caregiver] = await Promise.all([
    Account.exists({ familyId, role: 'senior', emailVerifiedAt: { $ne: null } }),
    Account.exists({ familyId, role: 'caregiver', emailVerifiedAt: { $ne: null } })
  ]);
  return Boolean(senior && caregiver);
}
async function requireVerified(req, res, next) {
  if (databaseRequired(res)) return;
  if (!req.session?.accountId) return res.status(401).json({ error: 'Sign in to view family details.', code: 'AUTH_REQUIRED' });
  try {
    const account = await Account.findById(req.session.accountId);
    if (!account || !account.emailVerifiedAt) {
      req.session.destroy(() => {});
      return res.status(403).json({ error: 'Verify your email before viewing family details.', code: 'EMAIL_NOT_VERIFIED' });
    }
    if (req.session.sessionVersion !== account.sessionVersion) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Sign in again to continue.', code: 'AUTH_REQUIRED' });
    }
    const familyReady = await familyIsReady(account.familyId);
    if (!familyReady && account.role === 'senior') return res.status(403).json({ error: 'The caregiver must also verify their email before family details are available.', code: 'FAMILY_NOT_VERIFIED' });
    req.authAccount = account;
    next();
  } catch (error) { next(error); }
}
function requireRole(role) {
  return (req, res, next) => req.authAccount?.role === role
    ? next()
    : res.status(403).json({ error: 'This action is not available for your account role.', code: 'ROLE_FORBIDDEN' });
}

function dateKey(value) {
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value;
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function dayWindow(key) {
  const [year, month, day] = dateKey(key).split('-').map(Number);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  return { start, end: new Date(year, month - 1, day, 23, 59, 59, 999) };
}
function scheduledAt(key, time) {
  const [year, month, day] = dateKey(key).split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

async function sendCaregiverAlertEmail(alert) {
  if (!smtpReady()) return 'not_configured';
  try {
    const caregivers = await Account.find({
      familyId: alert.familyId,
      role: 'caregiver',
      emailVerifiedAt: { $ne: null }
    }).select('email').lean();
    if (!caregivers.length) return 'no_verified_caregiver';
    const transport = createSmtpTransport();
    const scheduledTime = new Date(alert.scheduledFor).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    await transport.sendMail({
      from: emailSender(),
      to: caregivers.map(caregiver => caregiver.email).join(', '),
      subject: `MedVigil alert: ${alert.medicationName} needs attention`,
      text: `${alert.message}\n\nMedication: ${alert.medicationName}\nScheduled: ${scheduledTime}\n\nPlease check in with your family member.`,
      html: `<p>${escapeHtml(alert.message)}</p><p><strong>Medication:</strong> ${escapeHtml(alert.medicationName)}<br><strong>Scheduled:</strong> ${escapeHtml(scheduledTime)}</p><p>Please check in with your family member.</p>`
    });
    return 'sent';
  } catch (error) {
    console.error('Unable to send caregiver email alert:', error.message);
    return 'failed';
  }
}

async function createOrUpdateCareAlert({ medication, scheduledFor, message, reopen = false }) {
  let alert = await CareAlert.findOne({ medicationId: medication._id, scheduledFor });
  if (!alert) {
    alert = new CareAlert({
      familyId: medication.familyId,
      medicationId: medication._id,
      medicationName: medication.name,
      scheduledFor,
      message
    });
    try { await alert.save(); }
    catch (error) {
      if (error.code !== 11000) throw error;
      alert = await CareAlert.findOne({ medicationId: medication._id, scheduledFor });
      if (!alert) throw error;
    }
  } else {
    alert.medicationName = medication.name;
    alert.message = message;
    if (reopen && alert.resolvedAt) {
      alert.resolvedAt = null;
      alert.emailStatus = 'pending';
    }
    await alert.save();
  }
  if (alert.emailStatus !== 'sent') {
    alert.emailStatus = await sendCaregiverAlertEmail(alert);
    await alert.save();
    console.log(`Caregiver alert created for ${medication.name}; email ${alert.emailStatus}.`);
  }
  return alert;
}

async function checkOverdueDoses() {
  if (mongoose.connection.readyState !== 1) return;
  const now = new Date();
  const key = dateKey();
  const medications = await Medication.find({ active: true }).lean();
  for (const medication of medications) {
    const scheduledFor = scheduledAt(key, medication.time);
    if (now.getTime() - scheduledFor.getTime() < 30 * 60 * 1000) continue;
    const existingDose = await DoseLog.findOne({ medicationId: medication._id, scheduledFor }).lean();
    if (existingDose?.status === 'taken') continue;
    const existingAlert = await CareAlert.findOne({ medicationId: medication._id, scheduledFor }).lean();
    if (existingAlert) continue;
    try {
      await createOrUpdateCareAlert({
        medication,
        scheduledFor,
        message: 'No check-in was received within 30 minutes of this medication’s scheduled time.'
      });
    } catch (error) {
      if (error.code !== 11000) console.error('Unable to create care alert:', error.message);
    }
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));

app.get('/api/auth/me', (req, res, next) => {
  if (!req.session?.accountId || mongoose.connection.readyState !== 1) return res.json({ authenticated: false });
  Account.findById(req.session.accountId).then(account => {
    if (!account?.emailVerifiedAt || req.session.sessionVersion !== account.sessionVersion) return res.json({ authenticated: false });
    return Promise.all([
      familyIsReady(account.familyId),
      account.role === 'caregiver' ? Family.findById(account.familyId).select('+inviteCode seniorName') : null,
      Account.find({ familyId: account.familyId, emailVerifiedAt: { $ne: null } }).select('name role').lean()
    ]).then(([familyReady, family, members]) => {
      res.json({ authenticated: true, familyReady, user: { name: account.name, email: account.email, role: account.role }, ...(account.role === 'caregiver' ? { familyCode: family?.inviteCode, familyProfile: { seniorName: family?.seniorName || '' } } : {}), ...(familyReady ? { familyMembers: members.map(member => ({ name: member.name, role: member.role })) } : {}) });
    });
  }).catch(next);
});

app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  try {
    if (databaseRequired(res)) return;
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const role = req.body.role;
    const familyCodeInput = String(req.body.familyCode || '').trim().toUpperCase();
    let family;
    let familyCode;
    if (!['senior', 'caregiver'].includes(role)) return res.status(400).json({ error: 'Choose a senior or caregiver account.' });
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter a name between 2 and 80 characters.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Use a password between 10 and 128 characters.' });
    if (!smtpReady() && process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'Email verification is temporarily unavailable. Please try again later.' });
    if (await Account.exists({ email })) return res.status(409).json({ error: 'An account with that email already exists. Sign in or request a new verification email.' });
    if (role === 'caregiver' && familyCodeInput) {
      family = await Family.findOne({ inviteCode: familyCodeInput }).select('+inviteCode');
      if (!family) return res.status(400).json({ error: 'That family invite code was not found. Ask the caregiver to send a new invitation.' });
    } else if (role === 'caregiver') {
      familyCode = crypto.randomBytes(8).toString('hex').toUpperCase();
      family = await Family.create({ name: `${name}'s family`, inviteCode: familyCode });
    } else {
      if (!familyCodeInput) return res.status(400).json({ error: 'Ask the caregiver for the family invite code.' });
      family = await Family.findOne({ inviteCode: familyCodeInput }).select('+inviteCode');
      if (!family) return res.status(400).json({ error: 'That family invite code was not found. Ask the caregiver to check it.' });
      family.seniorName = name;
      await family.save();
    }
    const rawToken = crypto.randomBytes(32).toString('hex');
    const account = await Account.create({ name, email, familyId: family._id, passwordHash: await bcrypt.hash(password, 12), role, verificationTokenHash: hashToken(rawToken), verificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    if (role === 'caregiver' && !familyCodeInput) { family.createdBy = account._id; await family.save(); }
    let delivery;
    try { delivery = await sendVerificationEmail(account, rawToken, role === 'caregiver' && !familyCodeInput ? familyCode : undefined); }
    catch (error) {
      console.error('Verification email could not be sent:', error.message);
      delivery = { sent: false };
    }
    res.status(201).json({ ok: true, verificationRequired: true, message: delivery.sent ? 'Check your email for a verification link.' : 'Your account is saved, but the email could not be sent. Try sending the verification email again.', ...(role === 'caregiver' && !familyCodeInput ? { familyCode } : {}), ...(!delivery.sent && delivery.url && process.env.NODE_ENV !== 'production' ? { verificationUrl: delivery.url } : {}) });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'An account with that email already exists. Sign in or request a new verification email.' });
    next(error);
  }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    if (databaseRequired(res)) return;
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const role = req.body.role;
    if (!['senior', 'caregiver'].includes(role)) return res.status(400).json({ error: 'Choose a senior or caregiver sign-in page.' });
    const account = await Account.findOne({ email }).select('+passwordHash');
    if (!account || !(await bcrypt.compare(password, account.passwordHash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
    if (account.role !== role) return res.status(403).json({ error: 'This email belongs to the other account type. Use that role’s sign-in page.', code: 'ROLE_MISMATCH' });
    if (!account.emailVerifiedAt) return res.status(403).json({ error: 'Verify your email before signing in.', code: 'EMAIL_NOT_VERIFIED' });
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.accountId = String(account._id);
    req.session.accountRole = account.role;
    req.session.sessionVersion = account.sessionVersion;
    await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    res.json({ ok: true, user: { name: account.name, email: account.email, role: account.role } });
  } catch (error) { next(error); }
});

app.post('/api/auth/request-password-reset', authLimiter, async (req, res, next) => {
  try {
    if (databaseRequired(res)) return;
    if (!smtpReady() && process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'Password reset email is temporarily unavailable. Please try again later.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const role = req.body.role;
    if (!['senior', 'caregiver'].includes(role) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    const account = await Account.findOne({ email, role }).select('+passwordResetTokenHash +passwordResetExpiresAt');
    if (account) {
      const token = crypto.randomBytes(32).toString('hex');
      account.passwordResetTokenHash = hashToken(token);
      account.passwordResetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await account.save();
      try { await sendPasswordResetEmail(account, token); }
      catch (error) { console.error('Password reset email could not be sent:', error.message); }
    }
    res.json({ ok: true, message: 'If an account matches that email, a password reset link will be sent.' });
  } catch (error) { next(error); }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res, next) => {
  try {
    if (databaseRequired(res)) return;
    const token = String(req.body.token || '');
    const password = String(req.body.password || '');
    const role = req.body.role;
    if (!['senior', 'caregiver'].includes(role) || !/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'This password reset link is invalid or expired.' });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Use a password between 10 and 128 characters.' });
    const account = await Account.findOne({ role, passwordResetTokenHash: hashToken(token), passwordResetExpiresAt: { $gt: new Date() } }).select('+passwordResetTokenHash +passwordResetExpiresAt');
    if (!account) return res.status(400).json({ error: 'This password reset link is invalid or expired.' });
    account.passwordHash = await bcrypt.hash(password, 12);
    account.passwordResetTokenHash = undefined;
    account.passwordResetExpiresAt = undefined;
    account.sessionVersion += 1;
    await account.save();
    res.json({ ok: true, message: 'Your password has been reset. Sign in with your new password.' });
  } catch (error) { next(error); }
});

app.post('/api/auth/resend-verification', authLimiter, async (req, res, next) => {
  try {
    if (databaseRequired(res)) return;
    const email = String(req.body.email || '').trim().toLowerCase();
    const role = req.body.role;
    const account = await Account.findOne({ email, role, emailVerifiedAt: null }).select('+verificationTokenHash +verificationExpiresAt');
    if (account) {
      if (!smtpReady() && process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'Email verification is temporarily unavailable. Please try again later.' });
      const rawToken = crypto.randomBytes(32).toString('hex');
      account.verificationTokenHash = hashToken(rawToken);
      account.verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await account.save();
      const family = account.role === 'caregiver' ? await Family.findById(account.familyId).select('+inviteCode') : null;
      const delivery = await sendVerificationEmail(account, rawToken, family?.inviteCode);
      return res.json({ ok: true, ...(!delivery.sent && process.env.NODE_ENV !== 'production' ? { verificationUrl: delivery.url } : {}) });
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/auth/verify', async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.redirect('/?verify=unavailable');
    const token = String(req.query.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) return res.redirect('/?verify=invalid');
    const account = await Account.findOne({ verificationTokenHash: hashToken(token) }).select('+verificationTokenHash +verificationExpiresAt');
    if (!account) return res.redirect('/?verify=invalid');
    const loginPage = account.role === 'senior' ? '/senior-login.html' : '/caregiver-login.html';
    if (!account.verificationExpiresAt || account.verificationExpiresAt < new Date()) return res.redirect(`${loginPage}?verified=expired`);
    account.emailVerifiedAt = new Date();
    account.verificationTokenHash = undefined;
    account.verificationExpiresAt = undefined;
    await account.save();
    res.redirect(`${loginPage}?verified=1`);
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(error => {
    if (error) return res.status(500).json({ error: 'Could not sign out.' });
    res.clearCookie('kindred.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.json({ ok: true });
  });
});

app.use('/api', requireVerified);

app.put('/api/family/profile', requireRole('caregiver'), async (req, res, next) => {
  try {
    const seniorName = String(req.body.seniorName || '').trim();
    if (seniorName.length > 80) return res.status(400).json({ error: 'The family member name must be 80 characters or fewer.' });
    const family = await Family.findByIdAndUpdate(req.authAccount.familyId, { $set: { seniorName } }, { new: true, runValidators: true });
    if (!family) return res.status(404).json({ error: 'Family not found.' });
    res.json({ ok: true, familyProfile: { seniorName: family.seniorName } });
  } catch (error) { next(error); }
});

app.post('/api/family/invite-caregiver', authLimiter, requireRole('caregiver'), async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid caregiver email address.' });
    if (email === req.authAccount.email) return res.status(400).json({ error: 'That is your email address. Enter another caregiver’s email.' });
    if (await Account.exists({ email })) return res.status(409).json({ error: 'An account with that email already exists. They can sign in to their existing account.' });
    const family = await Family.findById(req.authAccount.familyId).select('+inviteCode');
    if (!family) return res.status(404).json({ error: 'Family not found.' });
    const delivery = await sendCaregiverInviteEmail(email, req.authAccount.name, family.inviteCode);
    res.json({ ok: true, message: delivery.sent ? 'Caregiver invitation sent.' : 'Email delivery is not configured. Share this link with the caregiver instead.', ...(!delivery.sent ? { inviteUrl: delivery.url } : {}) });
  } catch (error) { next(error); }
});

app.get('/api/dashboard', async (req, res, next) => {
  try {
    const { start, end } = dayWindow(req.query.date);
    const [medications, logs, alerts] = await Promise.all([
      Medication.find({ familyId: req.authAccount.familyId, active: true }).sort({ time: 1 }).lean(),
      DoseLog.find({ familyId: req.authAccount.familyId, scheduledFor: { $gte: start, $lte: end } }).select('medicationId scheduledFor status recordedAt').populate('medicationId', 'name').sort({ recordedAt: -1 }).lean(),
      CareAlert.find({ familyId: req.authAccount.familyId, scheduledFor: { $gte: start, $lte: end }, resolvedAt: null }).sort({ createdAt: -1 }).limit(10).lean()
    ]);
    const logByMedication = new Map(logs.map(log => [String(log.medicationId?._id || log.medicationId), log]));
    const alertByMedication = new Map(alerts.map(alert => [String(alert.medicationId), alert]));
    res.json({
      medications: medications.map(med => {
        const log = logByMedication.get(String(med._id));
        const alert = alertByMedication.get(String(med._id));
        return { ...med, _id: String(med._id), status: log?.status || 'upcoming', escalated: Boolean(alert), scheduledFor: scheduledAt(dateKey(req.query.date), med.time).toISOString() };
      }),
      alerts: alerts.map(alert => ({ ...alert, _id: String(alert._id), medicationId: String(alert.medicationId) })),
      updates: logs.slice(0, 8).map(log => ({
        type: 'dose',
        medicationId: String(log.medicationId?._id || log.medicationId),
        medicationName: log.medicationId?.name || 'Medication',
        status: log.status,
        createdAt: log.recordedAt
      })),
      takenCount: logs.filter(log => log.status === 'taken').length,
      totalCount: medications.length,
      updatedAt: new Date().toISOString()
    });
  } catch (error) { next(error); }
});

app.get('/api/history', async (req, res, next) => {
  try {
    const days = Math.min(7, Math.max(1, Number(req.query.days) || 7));
    const endDate = dateKey(req.query.date);
    const endWindow = dayWindow(endDate).end;
    const startDate = new Date(endWindow);
    startDate.setDate(startDate.getDate() - (days - 1));
    const { start } = dayWindow(dateKey(startDate));
    const [medications, logs] = await Promise.all([
      Medication.find({ familyId: req.authAccount.familyId, active: true }).select('_id').lean(),
      DoseLog.find({ familyId: req.authAccount.familyId, scheduledFor: { $gte: start, $lte: endWindow } }).populate('medicationId', 'name').sort({ scheduledFor: -1 }).lean()
    ]);
    const byDate = new Map();
    for (let offset = 0; offset < days; offset += 1) {
      const date = new Date(endWindow); date.setDate(date.getDate() - offset);
      const key = dateKey(date);
      byDate.set(key, { date: key, total: medications.length, tracked: 0, taken: 0, notTaken: 0, missed: 0, events: [] });
    }
    for (const log of logs) {
      const key = dateKey(log.scheduledFor);
      const day = byDate.get(key); if (!day) continue;
      day.tracked += 1;
      if (log.status === 'taken') day.taken += 1;
      else day.notTaken += 1;
      if (log.status === 'missed') day.missed += 1;
      day.events.push({ medicationId: String(log.medicationId?._id || log.medicationId), medicationName: log.medicationId?.name || 'Medication', status: log.status, time: log.recordedAt });
    }
    res.json({ days: [...byDate.values()] });
  } catch (error) { next(error); }
});

app.post('/api/medications', requireRole('caregiver'), async (req, res, next) => {
  try {
    const medication = await Medication.create({
      name: req.body.name,
      familyId: req.authAccount.familyId,
      dose: req.body.dose,
      time: req.body.time,
      note: req.body.note || 'as directed',
      icon: req.body.icon || '✧',
      color: ['sun', 'blue', 'lavender', 'peach'].includes(req.body.color) ? req.body.color : 'lavender',
      critical: Boolean(req.body.critical)
    });
    res.status(201).json({ ...medication.toObject(), _id: String(medication._id), status: 'upcoming' });
  } catch (error) { next(error); }
});

async function recordDoseStatus(req, res, next) {
  try {
    if (!['taken', 'not_taken'].includes(req.body.status)) return res.status(400).json({ error: 'status must be taken or not_taken.' });
    const medication = await Medication.findOne({ _id: req.params.id, familyId: req.authAccount.familyId, active: true });
    if (!medication) return res.status(404).json({ error: 'Medication not found.' });
    const recordedAt = req.body.recordedAt ? new Date(req.body.recordedAt) : new Date();
    if (Number.isNaN(recordedAt.getTime())) return res.status(400).json({ error: 'A valid recordedAt timestamp is required.' });
    const scheduledFor = req.body.scheduledFor ? new Date(req.body.scheduledFor) : scheduledAt(dateKey(recordedAt), medication.time);
    if (Number.isNaN(scheduledFor.getTime())) return res.status(400).json({ error: 'A valid scheduledFor timestamp is required.' });
    const previousLog = await DoseLog.findOne({ medicationId: medication._id, scheduledFor }).lean();
    const log = await DoseLog.findOneAndUpdate(
      { medicationId: medication._id, scheduledFor },
      { $set: { familyId: req.authAccount.familyId, status: req.body.status, recordedAt } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    if (req.body.status === 'taken') await CareAlert.updateMany({ familyId: req.authAccount.familyId, medicationId: medication._id, scheduledFor, resolvedAt: null }, { $set: { resolvedAt: recordedAt } });
    if (req.body.status === 'not_taken' && previousLog?.status !== 'not_taken') {
      await createOrUpdateCareAlert({
        medication,
        scheduledFor,
        message: 'The senior marked this medication as not taken.',
        reopen: previousLog?.status === 'taken'
      });
    }
    res.status(200).json({ ok: true, medicationId: String(medication._id), status: log.status, recordedAt: log.recordedAt });
  } catch (error) { next(error); }
}
app.post('/api/medications/:id/status', requireRole('senior'), recordDoseStatus);
app.post('/api/medications/:id/taken', requireRole('senior'), (req, res, next) => { req.body.status = 'taken'; recordDoseStatus(req, res, next); });

app.get('/', async (req, res, next) => {
  if (!req.session?.accountId || mongoose.connection.readyState !== 1) return res.sendFile(path.join(__dirname, 'welcome.html'));
  try {
    const account = await Account.findById(req.session.accountId);
    if (account?.emailVerifiedAt && req.session.sessionVersion === account.sessionVersion && (account.role === 'caregiver' || await familyIsReady(account.familyId))) { res.set('Cache-Control', 'no-store'); return res.sendFile(path.join(__dirname, 'index.html')); }
    if (!account?.emailVerifiedAt) req.session.destroy(() => {});
    res.sendFile(path.join(__dirname, 'welcome.html'));
  } catch (error) { next(error); }
});
app.get('/index.html', async (req, res, next) => {
  if (!req.session?.accountId || mongoose.connection.readyState !== 1) return res.redirect('/');
  try {
    const account = await Account.findById(req.session.accountId);
    if (!account?.emailVerifiedAt || req.session.sessionVersion !== account.sessionVersion || (account.role !== 'caregiver' && !(await familyIsReady(account.familyId)))) return res.redirect('/');
    res.set('Cache-Control', 'no-store');
    return res.sendFile(path.join(__dirname, 'index.html'));
  } catch (error) { next(error); }
});
app.use((req, res, next) => {
  if (/^\/(?:\.env(?:\.[^/]*)?|server\.js|package(?:-lock)?\.json|README\.md)$/i.test(req.path)) return res.sendStatus(404);
  next();
});
app.use(express.static(path.join(__dirname), { index: false, dotfiles: 'ignore' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'welcome.html')));
app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.name === 'ValidationError' || error.name === 'CastError' ? 400 : 500;
  res.status(status).json({ error: status === 400 ? error.message : 'Something went wrong.' });
});

async function start() {
  const port = Number(process.env.PORT) || 3000;
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('Connected to MongoDB.');
      await checkOverdueDoses();
      setInterval(() => checkOverdueDoses().catch(error => console.error('Escalation check failed:', error.message)), 60_000);
    } catch (error) {
      console.error(`MongoDB is unavailable: ${error.message}`);
      console.error('The interface will still load, but persistent records and server escalations need MongoDB.');
    }
  } else {
    console.log('MONGODB_URI is unset. Set it in .env to enable persistent family data and server escalations.');
  }
  app.listen(port, () => console.log(`MedVigil FMR is ready at http://localhost:${port}`));
}

start();
