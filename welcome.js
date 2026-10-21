const pairing = document.getElementById('family-pairing');
const params = new URLSearchParams(window.location.search);
fetch('/api/auth/me').then(response => response.json()).then(data => {
  if (data.authenticated && !data.familyReady) {
    pairing.hidden = false;
    if (data.user.role === 'caregiver') {
      document.getElementById('family-pair-title').textContent = 'Your email is verified';
      document.getElementById('family-pair-description').textContent = 'Your caregiver dashboard is ready. Sign in to add the family member’s name and medication schedule, then share this invite code so they can join.';
      if (data.familyCode) {
        document.getElementById('pair-code-value').textContent = data.familyCode;
        document.getElementById('pair-code').hidden = false;
      }
      document.getElementById('pair-signin-link').textContent = 'Caregiver sign in';
      document.getElementById('pair-signin-link').href = 'caregiver-login.html';
    } else {
      document.getElementById('family-pair-title').textContent = 'Your email is verified';
      document.getElementById('family-pair-description').textContent = 'Your caregiver also needs to verify their email before the family medication dashboard is unlocked.';
      document.getElementById('pair-signin-link').textContent = 'Senior sign in';
    }
  }
}).catch(() => {});
if (params.get('verify') === 'invalid') {
  pairing.hidden = false;
  document.getElementById('family-pair-title').textContent = 'Verification link not accepted';
  document.getElementById('family-pair-description').textContent = 'The link may have expired or already been used. Sign in to request another email.';
}
if (params.get('verify') === 'unavailable') {
  pairing.hidden = false;
  document.getElementById('family-pair-title').textContent = 'Verification is temporarily unavailable';
  document.getElementById('family-pair-description').textContent = 'We could not reach the account database. Please try opening your verification link again in a moment.';
}
document.getElementById('pair-code-copy').addEventListener('click', async () => {
  const button = document.getElementById('pair-code-copy');
  try { await navigator.clipboard.writeText(document.getElementById('pair-code-value').textContent); button.textContent = 'Copied'; }
  catch { button.textContent = 'Select and copy the code'; }
});
