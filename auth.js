const form = document.getElementById('auth-form');
const role = form.dataset.role;
let mode = 'login';
let pendingEmail = '';
const errorBox = document.getElementById('auth-error');
const notice = document.getElementById('verification-box');

function setMode(nextMode) {
  mode = nextMode;
  form.hidden = false;
  document.querySelectorAll('.auth-tab').forEach(tab => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  const nameField = document.querySelector('.auth-name-field');
  nameField.hidden = mode !== 'register';
  nameField.querySelector('input').required = mode === 'register';
  const familyField = document.querySelector('.auth-family-field');
  if (familyField) {
    familyField.hidden = mode !== 'register';
    familyField.querySelector('input').required = mode === 'register' && role === 'senior';
  }
  const password = document.getElementById('password');
  password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  document.querySelector('.auth-hint').hidden = mode !== 'register';
  document.querySelector('.registration-note').hidden = mode !== 'register';
  document.getElementById('forgot-password').hidden = mode !== 'login';
  document.getElementById('auth-submit').innerHTML = mode === 'register' ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
  document.getElementById('login-title').textContent = mode === 'register' ? 'Create your MedVigil account' : (role === 'senior' ? 'Welcome to your routine' : 'Welcome back');
  errorBox.textContent = '';
  notice.hidden = true;
}
function showError(message) { errorBox.textContent = message; }
async function readResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || 'We couldn’t complete that request.'); error.code = data.code; throw error; }
  return data;
}

document.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => setMode(tab.dataset.mode)));
form.addEventListener('submit', async event => {
  event.preventDefault(); errorBox.textContent = '';
  const values = new FormData(form);
  const payload = { role, email: String(values.get('email') || '').trim(), password: String(values.get('password') || '') };
  if (mode === 'register') {
    payload.name = String(values.get('name') || '').trim();
    payload.familyCode = String(values.get('familyCode') || '').trim();
  }
  const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
  const submit = document.getElementById('auth-submit');
  submit.disabled = true; submit.textContent = mode === 'register' ? 'Creating account…' : 'Signing in…';
  try {
    const data = await readResponse(await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
    if (mode === 'register') {
      pendingEmail = payload.email;
      notice.hidden = false;
      notice.querySelector('p').textContent = data.message || notice.querySelector('p').textContent;
      if (data.verificationUrl) {
        const link = document.getElementById('dev-verification-link'); link.href = data.verificationUrl; link.hidden = false;
      }
      if (data.familyCode) {
        document.getElementById('family-code-value').textContent = data.familyCode;
        document.getElementById('family-code-result').hidden = false;
      }
      document.getElementById('resend-verification').hidden = false;
      form.hidden = true;
    } else {
      window.location.assign('/');
    }
  } catch (error) {
    if (error.code === 'EMAIL_NOT_VERIFIED') {
      pendingEmail = payload.email; notice.hidden = false; form.hidden = true;
      document.getElementById('resend-verification').hidden = false;
      document.querySelector('#verification-box p').textContent = 'We still need to verify this email before showing family medication details. Check your inbox or send a new verification email.';
    } else showError(error.message);
  } finally {
    submit.disabled = false;
    submit.innerHTML = mode === 'register' ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
  }
});

document.getElementById('resend-verification').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  try {
    const data = await readResponse(await fetch('/api/auth/resend-verification', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: pendingEmail, role }) }));
    if (data.verificationUrl) {
      const link = document.getElementById('dev-verification-link'); link.href = data.verificationUrl; link.hidden = false;
    }
    event.currentTarget.textContent = 'Verification email sent';
  } catch (error) {
    document.querySelector('#verification-box p').textContent = error.message;
    event.currentTarget.disabled = false;
  }
});
document.getElementById('back-to-sign-in').addEventListener('click', () => {
  notice.hidden = true; form.hidden = false; setMode('login');
  document.getElementById('email').value = pendingEmail;
});

const tabs = document.querySelector('.auth-tabs');
const forgotPasswordLink = document.getElementById('forgot-password');
const forgotPasswordPanel = document.getElementById('forgot-password-panel');
const resetPasswordPanel = document.getElementById('reset-password-panel');
const resetEmailInput = document.getElementById('reset-email');
forgotPasswordLink.addEventListener('click', () => {
  resetEmailInput.value = document.getElementById('email').value.trim();
  document.getElementById('reset-request-error').textContent = '';
  document.getElementById('reset-request-success').hidden = true;
  form.hidden = true; tabs.hidden = true; forgotPasswordLink.hidden = true;
  forgotPasswordPanel.hidden = false;
  resetEmailInput.focus();
});
document.getElementById('cancel-forgot-password').addEventListener('click', () => {
  forgotPasswordPanel.hidden = true; tabs.hidden = false;
  form.hidden = false; setMode('login');
  document.getElementById('email').value = resetEmailInput.value;
});
document.getElementById('request-password-reset').addEventListener('click', async event => {
  const error = document.getElementById('reset-request-error');
  const success = document.getElementById('reset-request-success');
  error.textContent = ''; success.hidden = true;
  if (!resetEmailInput.checkValidity()) { error.textContent = 'Enter a valid email address.'; return; }
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const data = await readResponse(await fetch('/api/auth/request-password-reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: resetEmailInput.value.trim(), role })
    }));
    success.textContent = data.message;
    success.hidden = false;
  } catch (requestError) { error.textContent = requestError.message; }
  finally { button.disabled = false; }
});
document.getElementById('cancel-reset-password').addEventListener('click', () => {
  resetPasswordPanel.hidden = true; tabs.hidden = false; form.hidden = false;
  resetToken = '';
  setMode('login');
  document.getElementById('verified-message').textContent = 'Request a new password reset link to continue.';
});
document.getElementById('save-new-password').addEventListener('click', async event => {
  const password = document.getElementById('new-password').value;
  const confirmation = document.getElementById('confirm-password').value;
  const error = document.getElementById('reset-password-error');
  error.textContent = '';
  if (password.length < 10 || password.length > 128) { error.textContent = 'Use a password between 10 and 128 characters.'; return; }
  if (password !== confirmation) { error.textContent = 'The passwords do not match.'; return; }
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const data = await readResponse(await fetch('/api/auth/reset-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, token: resetToken, password })
    }));
    resetPasswordPanel.hidden = true; tabs.hidden = false; form.hidden = false;
    document.getElementById('new-password').value = '';
    document.getElementById('confirm-password').value = '';
    resetToken = '';
    setMode('login');
    document.getElementById('verified-message').textContent = data.message;
  } catch (resetError) { error.textContent = resetError.message; }
  finally { button.disabled = false; }
});
const copyCodeButton = document.getElementById('copy-family-code');
if (copyCodeButton) copyCodeButton.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(document.getElementById('family-code-value').textContent); copyCodeButton.textContent = 'Copied'; }
  catch { copyCodeButton.textContent = 'Select and copy the code above'; }
});

const params = new URLSearchParams(window.location.search);
const familyCodeInput = document.getElementById('family-code');
if (familyCodeInput && params.get('familyCode')) {
  familyCodeInput.value = params.get('familyCode').trim().toUpperCase();
  if (role === 'caregiver') {
    document.querySelector('.registration-note').textContent = 'You were invited to join an existing family care circle. Create your caregiver account to continue.';
    setMode('register');
  }
}
if (params.get('verified') === '1') document.getElementById('verified-message').textContent = 'Your email is verified. Sign in to continue.';
if (params.get('verified') === 'expired') document.getElementById('verified-message').textContent = 'That verification link expired. Sign in and request a new one.';
if (params.get('error') === 'invalid-link') document.getElementById('verified-message').textContent = 'That verification link is invalid or has already been used.';
let resetToken = params.get('reset') || '';
if (resetToken && /^[a-f0-9]{64}$/.test(resetToken)) {
  form.hidden = true; tabs.hidden = true; forgotPasswordLink.hidden = true;
  notice.hidden = true; forgotPasswordPanel.hidden = true; resetPasswordPanel.hidden = false;
  document.getElementById('login-title').textContent = 'Choose a new password';
  document.querySelector('.login-subtitle').textContent = 'Create a new password to sign in to your family account.';
  history.replaceState(null, '', window.location.pathname);
} else {
  if (params.has('reset')) document.getElementById('verified-message').textContent = 'That password reset link is invalid. Request a new one below.';
  resetToken = '';
  fetch('/api/auth/me').then(readResponse).then(data => { if (data.authenticated) window.location.replace('/'); }).catch(() => {});
}
