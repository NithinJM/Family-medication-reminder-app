let medications = [];
let apiConnected = false;
let toastTimer;
let historyRange = 'day';
let activeView = 'caregiver';
let apiAlerts = [];
let seniorDisplayName = 'your family member';
let currentAccountName = '';
let currentRole = '';
let caregiverSubtitle = '';
let familyInviteCode = '';
let familyMembers = [];
let familyReady = false;
const bucketOrder = ['Morning', 'Afternoon', 'Evening'];

function todayKey(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function timeParts(value) { const [hour, minute] = value.split(':').map(Number); return { hour, minute }; }
function displayTime(value) {
  const { hour, minute } = timeParts(value); const date = new Date(); date.setHours(hour, minute, 0, 0);
  return `${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', ' <small>') + '</small>'}`;
}
function dayBucket(time) { const hour = Number(time.split(':')[0]); return hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening'; }
function sortedMeds() { return [...medications].sort((a, b) => a.time.localeCompare(b.time)); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function statusLabel(status, escalated = false) {
  if (escalated || status === 'missed') return '<span class="dose-status missed">Missed · alert sent</span>';
  if (status === 'taken') return '<span class="dose-status taken">Taken</span>';
  if (status === 'not_taken') return '<span class="dose-status not-taken">Not taken</span>';
  return '<span class="dose-status upcoming">Upcoming</span>';
}
function seniorControls(med) {
  const status = med.status || 'upcoming';
  const previewOnly = currentRole === 'caregiver';
  const disabled = previewOnly ? 'disabled aria-disabled="true" title="Preview only; medication actions are disabled"' : '';
  return `<div class="senior-actions"><button class="choice-taken ${status === 'taken' ? 'selected' : ''}" data-dose="${med._id}" data-status="taken" aria-pressed="${status === 'taken'}" ${disabled}><span>✓</span> Taken</button><button class="choice-not-taken ${status === 'not_taken' ? 'selected' : ''}" data-dose="${med._id}" data-status="not_taken" aria-pressed="${status === 'not_taken'}" ${disabled}><span>×</span> Not taken</button></div>`;
}
function renderSchedule() {
  const seniorMode = document.body.classList.contains('senior-mode');
  const title = document.getElementById('routine-title');
  const caption = document.getElementById('schedule-caption');
  title.textContent = activeView === 'medications' ? 'All medications' : seniorMode ? 'Your daily routine' : 'Today’s schedule';
  caption.textContent = activeView === 'medications'
    ? `${medications.length} active medication${medications.length === 1 ? '' : 's'} · grouped by time of day`
    : `${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · ${medications.length} reminders`;
  const groups = Object.fromEntries(bucketOrder.map(bucket => [bucket, sortedMeds().filter(med => dayBucket(med.time) === bucket)]));
  if (!medications.length) {
    document.getElementById('schedule-list').innerHTML = '<p class="empty-notification">No medications have been added to this family routine yet.</p>';
    return;
  }
  document.getElementById('schedule-list').innerHTML = bucketOrder.filter(bucket => groups[bucket].length).map(bucket => `
    <section class="routine-bucket" aria-label="${bucket} medications"><h3 class="bucket-title">${bucket}<span>${groups[bucket].filter(m => m.status === 'taken').length} of ${groups[bucket].length} complete</span></h3>
      ${groups[bucket].map(med => `<article class="schedule-row ${med.status === 'taken' ? 'row-complete' : ''}"><div class="schedule-time">${displayTime(med.time)}</div><span class="schedule-med-icon ${med.color || 'blue'}">${med.icon || '✧'}</span><div class="schedule-med-name">${escapeHtml(med.name)}${med.critical ? '<span class="critical-tag">IMPORTANT</span>' : ''}<span class="schedule-med-dose">${escapeHtml(med.dose)} · ${escapeHtml(med.note || 'as directed')}</span></div>${seniorMode ? seniorControls(med) : statusLabel(med.status, med.escalated)}</article>`).join('')}
    </section>`).join('');
  document.querySelectorAll('[data-dose]').forEach(button => button.addEventListener('click', () => setDoseStatus(button.dataset.dose, button.dataset.status)));
}
function renderSummary() {
  const completed = medications.filter(m => m.status === 'taken').length;
  const total = medications.length;
  document.getElementById('dose-count').textContent = completed;
  document.querySelector('.stat-of').textContent = `of ${total}`;
  document.getElementById('dose-progress').style.width = `${total ? completed / total * 100 : 0}%`;
  const next = sortedMeds().find(m => m.status !== 'taken');
  if (next) {
    document.getElementById('next-med-name').textContent = next.name;
    document.getElementById('next-med-dose').textContent = `${next.dose} · ${next.note || 'as directed'}`;
    document.getElementById('next-med-time').innerHTML = displayTime(next.time);
  } else {
    document.getElementById('next-med-name').textContent = total ? 'All done for today' : 'No medications added yet';
    document.getElementById('next-med-dose').textContent = total ? 'Every scheduled dose is checked off.' : 'Ask a caregiver to add your routine.';
    document.getElementById('next-med-time').textContent = '✓';
  }
  const criticalAlerts = apiAlerts.filter(alert => alert.type !== 'dose' && !alert.readAt);
  const overdue = medications.filter(m => m.escalated);
  const title = document.getElementById('alert-title');
  const description = document.getElementById('alert-description');
  const time = document.getElementById('alert-time');
  const banner = document.getElementById('alert-banner');
  banner.classList.toggle('alert-escalation', criticalAlerts.length > 0 || overdue.length > 0);
  if (criticalAlerts.length || overdue.length) {
    title.textContent = 'A critical dose needs attention';
    description.textContent = `${criticalAlerts.length || overdue.length} critical medication${(criticalAlerts.length || overdue.length) === 1 ? '' : 's'} not confirmed within 30 minutes.`;
    time.textContent = 'ESCALATED';
  } else {
    title.textContent = total && completed === total ? 'Today’s medication routine is complete' : 'Medication routine is on track';
    description.textContent = `${completed} of ${total} doses confirmed. Check the routine history for recent updates.`;
    time.textContent = 'TODAY';
  }
  document.querySelector('.live-status').innerHTML = apiConnected ? '<span></span>Live family updates' : '<span></span>Demo mode';
  renderSchedule();
  renderNotifications();
}
function renderNotifications() {
  const panel = document.getElementById('notification-panel');
  if (!panel) return;
  const alerts = apiAlerts.slice(0, 4);
  if (!alerts.length) { panel.innerHTML = '<p class="empty-notification">No missed-dose alerts. Family updates will appear here.</p>'; return; }
  panel.innerHTML = alerts.map(alert => {
    const isDose = alert.type === 'dose';
    const title = isDose ? `${seniorDisplayName} marked ${alert.medicationName || 'a dose'} ${alert.status === 'taken' ? 'taken' : 'not taken'}` : `${alert.medicationName || 'Medication'} needs attention`;
    const message = isDose ? (alert.status === 'taken' ? 'Dose check-in received by the family.' : `Please check in with ${seniorDisplayName} about this dose.`) : alert.message || 'Not marked taken within 30 minutes of its scheduled time.';
    return `<article class="notification-row ${isDose ? 'dose-update' : ''}"><span class="notification-alert-icon">${isDose ? (alert.status === 'taken' ? '✓' : '×') : '!'}</span><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div><time>${new Date(alert.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></article>`;
  }).join('');
}
async function setDoseStatus(id, status) {
  if (currentRole !== 'senior') return;
  const medication = medications.find(m => m._id === id); if (!medication) return;
  if (!apiConnected) return showToast('The family service is unavailable. Please try again in a moment.');
  try {
    const [year, month, day] = todayKey().split('-').map(Number);
    const { hour, minute } = timeParts(medication.time);
    const scheduledFor = new Date(year, month - 1, day, hour, minute).toISOString();
    const response = await fetch(`/api/medications/${encodeURIComponent(id)}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, recordedAt: new Date().toISOString(), scheduledFor }) });
    if (!response.ok) throw new Error('Could not sync dose status');
    medication.status = status; medication.escalated = false; renderSummary(); refreshHistory();
  } catch { apiConnected = false; showToast('Could not save this update. Please try again.'); return; }
  showToast(status === 'taken' ? `${medication.name} marked taken. Your family has been updated.` : `${medication.name} marked not taken. Your family has been updated.`);
}
async function syncDashboard() {
  try {
    const response = await fetch(`/api/dashboard?date=${todayKey()}`, { headers: { Accept: 'application/json' } });
    if (response.status === 401 || response.status === 403) return window.location.replace('/');
    if (!response.ok) throw new Error('API unavailable');
    const data = await response.json();
    if (Array.isArray(data.medications)) {
      medications = data.medications; apiAlerts = [...(data.alerts || []), ...(data.updates || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); apiConnected = true;
      renderSummary(); refreshHistory();
    }
  } catch { apiConnected = false; }
}
function showToast(message) {
  const toast = document.getElementById('toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}
function renderHistory(data) {
  const records = Array.isArray(data) ? data : null;
  let days;
  if (records) days = records;
  else if (historyRange === 'day') {
    days = [{ date: todayKey(), total: medications.length, tracked: medications.filter(m => m.status !== 'upcoming').length, taken: medications.filter(m => m.status === 'taken').length, notTaken: medications.filter(m => ['not_taken', 'missed'].includes(m.status)).length, events: [] }];
  } else {
    days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(); date.setDate(date.getDate() - index); const key = todayKey(date);
      const events = [];
      const todayTaken = index === 0 ? medications.filter(m => m.status === 'taken').length : 0;
      const todayNotTaken = index === 0 ? medications.filter(m => ['not_taken', 'missed'].includes(m.status)).length : 0;
      return { date: key, total: medications.length, tracked: index === 0 ? medications.filter(m => m.status !== 'upcoming').length : 0, taken: todayTaken, notTaken: todayNotTaken, events };
    });
  }
  const list = document.getElementById('history-list');
  const tracked = days.reduce((sum, day) => sum + (day.tracked ?? ((day.taken || 0) + (day.notTaken || 0))), 0);
  const taken = days.reduce((sum, day) => sum + (day.taken || 0), 0);
  document.getElementById('history-summary').innerHTML = `<div><strong>${taken}</strong><span>doses confirmed</span></div><div><strong>${tracked ? `${Math.round(taken / tracked * 100)}%` : '—'}</strong><span>adherence</span></div><div><strong>${tracked}</strong><span>check-ins recorded</span></div>`;
  list.innerHTML = days.map(day => {
    const date = new Date(`${day.date}T12:00:00`);
    const label = historyRange === 'day' ? 'Today' : date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const events = (day.events || []).map(event => `<span class="history-event ${event.status}">${event.status === 'taken' ? '✓' : '×'} ${escapeHtml(event.medicationName || event.name || 'Dose')}</span>`).join('');
    const dayTracked = day.tracked ?? ((day.taken || 0) + (day.notTaken || 0));
    const statusCopy = dayTracked ? `${day.taken || 0} taken · ${day.notTaken || 0} not taken` : 'No check-ins recorded';
    return `<article class="history-day"><div class="history-date">${label}<span>${statusCopy}</span></div><div class="history-bar"><span style="width:${dayTracked ? Math.min(100, (day.taken || 0) / dayTracked * 100) : 0}%"></span></div><div class="history-events">${events || '<span class="history-empty">No check-ins recorded</span>'}</div></article>`;
  }).join('');
}
async function refreshHistory() {
  if (!apiConnected) { renderHistory(); return; }
  try {
    const days = historyRange === 'day' ? 1 : 7;
    const response = await fetch(`/api/history?days=${days}&date=${todayKey()}`);
    if (response.ok) renderHistory((await response.json()).days);
  } catch { renderHistory(); }
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  const view = button.dataset.view;
  activeView = view;
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  const settingsPanel = document.getElementById('settings-panel');
  document.querySelector('.page-content').classList.toggle('settings-view', view === 'settings');
  settingsPanel.hidden = view !== 'settings';
  document.getElementById('crumb-current').textContent = ({ caregiver: 'Overview', medications: 'Medications', schedule: 'Schedule', activity: 'Activity', settings: 'Settings' })[view] || view;
  if (view === 'settings') return window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view === 'medications' || view === 'schedule') {
    renderSchedule();
    document.querySelector('.schedule-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (view === 'activity') document.getElementById('history-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (view === 'caregiver') window.scrollTo({ top: 0, behavior: 'smooth' });
}));
document.getElementById('view-toggle').addEventListener('click', event => {
  if (currentRole !== 'caregiver') return;
  const senior = document.body.classList.toggle('senior-mode');
  event.currentTarget.querySelector('span').textContent = senior ? 'Caregiver view' : 'Senior view';
  document.querySelector('.welcome-row h1').innerHTML = `Good morning, ${escapeHtml(senior ? seniorDisplayName : currentAccountName)} <span class="wave">✳</span>`;
  document.querySelector('.subtitle').textContent = senior ? 'Senior routine preview. Medication actions are disabled here.' : caregiverSubtitle;
  renderSchedule();
  showToast(senior ? 'Senior preview opened. Dose actions are disabled.' : 'Caregiver dashboard');
});
document.getElementById('add-medication').addEventListener('click', () => document.getElementById('medication-dialog').showModal());
document.querySelector('.invite-button').addEventListener('click', () => {
  document.getElementById('invite-dialog-code').textContent = familyInviteCode || 'Unavailable';
  document.getElementById('caregiver-invite-feedback').textContent = '';
  document.getElementById('caregiver-invite-form').reset();
  document.getElementById('invite-dialog').showModal();
});
document.getElementById('close-invite-dialog').addEventListener('click', () => document.getElementById('invite-dialog').close());
document.getElementById('copy-invite-dialog-code').addEventListener('click', async () => {
  if (!familyInviteCode) return showToast('Your family invite code is not available.');
  try { await navigator.clipboard.writeText(familyInviteCode); showToast('Family invite code copied. Share it with the senior member.'); }
  catch { showToast(`Family invite code: ${familyInviteCode}`); }
});
document.getElementById('caregiver-invite-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const email = form.elements.email.value.trim();
  const feedback = document.getElementById('caregiver-invite-feedback');
  const submit = form.querySelector('[type="submit"]');
  feedback.textContent = '';
  submit.disabled = true;
  try {
    const response = await fetch('/api/family/invite-caregiver', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not send the caregiver invitation.');
    feedback.textContent = data.message;
    if (data.inviteUrl) {
      const link = document.createElement('a'); link.href = data.inviteUrl; link.textContent = 'Open caregiver invite link';
      feedback.append(' ', link);
    }
    form.elements.email.value = '';
  } catch (error) { feedback.textContent = error.message; }
  finally { submit.disabled = false; }
});
document.getElementById('copy-settings-code').addEventListener('click', async () => {
  if (!familyInviteCode) return showToast('Your family invite code is not available.');
  try { await navigator.clipboard.writeText(familyInviteCode); showToast('Family invite code copied.'); }
  catch { showToast(`Family invite code: ${familyInviteCode}`); }
});
document.querySelector('.notification-button').addEventListener('click', () => document.getElementById('notification-panel').scrollIntoView({ behavior: 'smooth', block: 'center' }));
async function signOut() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  window.location.replace('/');
}
document.getElementById('sign-out').addEventListener('click', signOut);
document.getElementById('sign-out-mobile').addEventListener('click', signOut);
document.querySelectorAll('.history-tab').forEach(tab => tab.addEventListener('click', () => {
  historyRange = tab.dataset.range;
  document.querySelectorAll('.history-tab').forEach(item => { const active = item === tab; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); });
  refreshHistory();
}));
document.getElementById('medication-form').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault(); const form = new FormData(event.currentTarget);
  const medication = { name: form.get('name').trim(), dose: form.get('dose').trim(), time: form.get('time'), note: form.get('with').trim() || 'as directed', icon: '✧', color: 'lavender', critical: form.get('critical') === 'on', status: 'upcoming' };
  if (!apiConnected) return showToast('The family service is unavailable. Please try again in a moment.');
  try {
    const response = await fetch('/api/medications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(medication) });
    if (!response.ok) throw new Error('Could not save this medication.');
    Object.assign(medication, await response.json());
    medications.push(medication); renderSummary(); event.currentTarget.reset(); document.getElementById('medication-dialog').close(); showToast(`${medication.name} added to ${seniorDisplayName}’s routine.`);
  } catch { apiConnected = false; showToast('Could not save this medication. Please try again.'); }
});

const today = new Date();
document.querySelector('.eyebrow').innerHTML = `<span class="sun-icon">☼</span> ${today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase()}`;
document.getElementById('today-label').textContent = today.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
document.getElementById('schedule-caption').textContent = 'Loading your verified family routine…';
document.querySelector('.live-status').textContent = 'Loading private family space';
document.getElementById('schedule-list').innerHTML = '<p class="empty-notification">Loading your family routine…</p>';
function renderCareCircle(members, profileName, isFamilyReady) {
  const panel = document.querySelector('.family-panel');
  panel.querySelectorAll('.member-row').forEach(row => row.remove());
  panel.querySelector('.panel-heading p').textContent = isFamilyReady ? 'People with verified family access' : 'Family setup in progress';
  const note = panel.querySelector('.care-note');
  if (profileName && !members.some(member => member.role === 'senior')) {
    const row = document.createElement('div'); row.className = 'member-row';
    const avatar = document.createElement('span'); avatar.className = 'avatar avatar-lilac large'; avatar.textContent = profileName.trim().charAt(0).toUpperCase();
    const copy = document.createElement('div'); copy.className = 'member-copy';
    const name = document.createElement('strong'); name.textContent = profileName;
    const detail = document.createElement('span'); detail.textContent = 'Family member'; copy.append(name, detail);
    const status = document.createElement('span'); status.className = 'online-pill online-muted'; status.textContent = 'Invite pending';
    row.append(avatar, copy, status); panel.insertBefore(row, note);
  }
  members.forEach((member, index) => {
    const senior = member.role === 'senior';
    const row = document.createElement('div'); row.className = 'member-row';
    const avatar = document.createElement('span'); avatar.className = `avatar large ${senior ? 'avatar-lilac' : 'avatar-green'}`; avatar.textContent = member.name.trim().charAt(0).toUpperCase();
    const copy = document.createElement('div'); copy.className = 'member-copy';
    const name = document.createElement('strong'); name.textContent = member.name;
    const tag = document.createElement('span'); tag.className = `you-tag ${senior ? '' : 'you-you'}`; tag.textContent = senior ? 'SENIOR' : 'CAREGIVER'; name.append(' ', tag);
    const detail = document.createElement('span'); detail.textContent = senior ? 'Senior family member' : 'Family caregiver'; copy.append(name, detail);
    const verified = document.createElement('span'); verified.className = 'online-pill'; verified.innerHTML = '<i></i> Verified';
    row.append(avatar, copy, verified); panel.insertBefore(row, note);
  });
}
document.getElementById('family-member-setup').addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.getElementById('senior-name');
  const feedback = document.getElementById('family-setup-feedback');
  const seniorName = input.value.trim();
  feedback.textContent = '';
  if (!seniorName) { feedback.textContent = 'Enter your family member’s name.'; input.focus(); return; }
  try {
    const response = await fetch('/api/family/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seniorName })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save the family member name.');
    seniorDisplayName = data.familyProfile.seniorName;
    feedback.textContent = 'Family member saved. Add their medication schedule and invite them to join.';
    renderCareCircle(familyMembers, seniorDisplayName, familyReady);
    document.querySelector('.subtitle').textContent = `Add medication times and dosages for ${seniorDisplayName}, then share the invite code.`;
  } catch (error) { feedback.textContent = error.message; }
});
async function initializePrivateApp() {
  try {
    const response = await fetch('/api/auth/me', { headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok || !data.authenticated) return window.location.replace('/');
    const user = data.user;
    const isSenior = user.role === 'senior';
    currentRole = user.role;
    const viewToggle = document.getElementById('view-toggle');
    viewToggle.hidden = isSenior;
    viewToggle.disabled = isSenior;
    currentAccountName = user.name;
    familyInviteCode = data.familyCode || '';
    document.getElementById('invite-dialog-code').textContent = familyInviteCode || 'Unavailable';
    document.getElementById('settings-family-code').textContent = familyInviteCode || 'Unavailable';
    familyMembers = data.familyMembers || [];
    familyReady = Boolean(data.familyReady);
    seniorDisplayName = familyMembers.find(member => member.role === 'senior')?.name || data.familyProfile?.seniorName || 'your family member';
    renderCareCircle(familyMembers, seniorDisplayName === 'your family member' ? '' : seniorDisplayName, familyReady);
    const familySetup = document.getElementById('family-member-setup');
    familySetup.hidden = isSenior || familyReady;
    document.getElementById('senior-name').value = data.familyProfile?.seniorName || '';
    document.querySelector('.welcome-row h1').innerHTML = `Good morning, ${escapeHtml(user.name)} <span class="wave">✳</span>`;
    document.querySelector('.subtitle').textContent = isSenior
      ? 'Tap one button for each medicine in your routine.'
      : familyReady
        ? `Here’s how ${seniorDisplayName} is doing today.`
        : seniorDisplayName === 'your family member'
          ? 'Add a family member and their medication schedule to get started.'
          : `Add medication times and dosages for ${seniorDisplayName}, then share the invite code.`;
    caregiverSubtitle = document.querySelector('.subtitle').textContent;
    document.getElementById('profile-avatar').textContent = user.name.trim().charAt(0).toUpperCase();
    document.getElementById('profile-identity').innerHTML = `${escapeHtml(user.name)}<small>${isSenior ? 'Senior account' : 'Family caregiver'}</small>`;
    if (isSenior) {
      document.body.classList.add('senior-mode', 'senior-account');
      document.getElementById('add-medication').hidden = true;
      document.getElementById('routine-title').textContent = 'Your daily routine';
    }
    await syncDashboard();
    setInterval(syncDashboard, 15000);
  } catch {
    window.location.replace('/');
  }
}
initializePrivateApp();
