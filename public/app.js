const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const DAY_SHORT = { monday:'MON', tuesday:'TUE', wednesday:'WED', thursday:'THU', friday:'FRI', saturday:'SAT', sunday:'SUN' };

let schedule = null;
let status = null;
let selectedDays = 7;
let countdownInterval = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  schedule = await fetch('/api/schedule').then(r => r.json());
  status = await fetch('/api/status').then(r => r.json());
  const focus = await fetch('/api/focus').then(r => r.json());

  document.getElementById('loading').classList.add('hidden');

  if (focus.active) {
    showFocusActive(focus);
  } else if (status.active && status.locked) {
    showLocked();
  } else {
    showEdit();
    setupFocus();
  }
  setupPasswordModal();
}

// ---------------------------------------------------------------------------
// EDIT MODE
// ---------------------------------------------------------------------------
function showEdit() {
  document.getElementById('edit-mode').classList.remove('hidden');
  document.getElementById('locked-mode').classList.add('hidden');
  buildDayRows();
  setupDurationButtons();
  setupPresets();
  setupCopyAll();
  setupLockButton();
}

function buildDayRows() {
  const container = document.getElementById('day-rows');
  container.innerHTML = '';
  DAYS.forEach(day => {
    const s = schedule.days[day] || { curfewStart: '22:00', curfewEnd: '06:00' };
    const row = document.createElement('div');
    row.className = 'day-row';
    row.innerHTML = `
      <div class="day-label">${DAY_SHORT[day]}</div>
      <div class="day-times">
        <input type="time" data-day="${day}" data-field="start" value="${s.curfewStart}">
        <span>→</span>
        <input type="time" data-day="${day}" data-field="end" value="${s.curfewEnd}">
      </div>`;
    container.appendChild(row);
  });
}

function getDaysFromUI() {
  const days = {};
  DAYS.forEach(day => {
    const start = document.querySelector(`input[data-day="${day}"][data-field="start"]`).value;
    const end = document.querySelector(`input[data-day="${day}"][data-field="end"]`).value;
    days[day] = { curfewStart: start || '22:00', curfewEnd: end || '06:00' };
  });
  return days;
}

function setupDurationButtons() {
  document.querySelectorAll('.dur-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dur-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('custom-days').value = '';
      selectedDays = parseInt(btn.dataset.days);
      updateLockBtn();
    });
  });
  document.getElementById('custom-days').addEventListener('input', (e) => {
    document.querySelectorAll('.dur-btn').forEach(b => b.classList.remove('active'));
    selectedDays = parseInt(e.target.value) || 0;
    updateLockBtn();
  });
}

function setupPresets() {
  const presets = {
    nightowl: { start: '22:00', end: '06:00' },
    earlybird: { start: '21:00', end: '05:00' },
    weekendflex: null // special
  };

  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const p = btn.dataset.preset;
      if (p === 'weekendflex') {
        DAYS.forEach(day => {
          const isWeekend = day === 'saturday' || day === 'sunday';
          const s = isWeekend ? '23:00' : '22:00';
          const e = isWeekend ? '07:00' : '06:00';
          document.querySelector(`input[data-day="${day}"][data-field="start"]`).value = s;
          document.querySelector(`input[data-day="${day}"][data-field="end"]`).value = e;
        });
      } else {
        const { start, end } = presets[p];
        DAYS.forEach(day => {
          document.querySelector(`input[data-day="${day}"][data-field="start"]`).value = start;
          document.querySelector(`input[data-day="${day}"][data-field="end"]`).value = end;
        });
      }
    });
  });
}

function setupCopyAll() {
  document.getElementById('copy-all-btn').addEventListener('click', () => {
    const monStart = document.querySelector('input[data-day="monday"][data-field="start"]').value;
    const monEnd = document.querySelector('input[data-day="monday"][data-field="end"]').value;
    DAYS.forEach(day => {
      document.querySelector(`input[data-day="${day}"][data-field="start"]`).value = monStart;
      document.querySelector(`input[data-day="${day}"][data-field="end"]`).value = monEnd;
    });
  });
}

function updateLockBtn() {
  document.getElementById('lock-btn').disabled = selectedDays < 1;
}

function setupLockButton() {
  document.getElementById('lock-btn').addEventListener('click', async () => {
    const days = getDaysFromUI();
    // Save schedule first
    await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days, lockPeriodDays: selectedDays, timezone: 'Asia/Kathmandu' })
    });
    // Show password modal
    showPasswordModal();
  });
}

function showPasswordModal() {
  const overlay = document.getElementById('modal-overlay');
  const input = document.getElementById('modal-password');
  const errorEl = document.getElementById('modal-error');

  overlay.classList.remove('hidden');
  input.value = '';
  errorEl.classList.add('hidden');
  input.focus();
}

function hidePasswordModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

function setupPasswordModal() {
  document.getElementById('modal-cancel').addEventListener('click', hidePasswordModal);

  document.getElementById('modal-confirm').addEventListener('click', async () => {
    const password = document.getElementById('modal-password').value;
    const errorEl = document.getElementById('modal-error');

    if (!password || password.length < 4) {
      errorEl.textContent = 'Password must be at least 4 characters';
      errorEl.classList.remove('hidden');
      return;
    }

    try {
      const res = await fetch('/api/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || 'Failed to lock';
        errorEl.classList.remove('hidden');
        return;
      }
      hidePasswordModal();
      schedule = data.schedule;
      status = await fetch('/api/status').then(r => r.json());
      document.getElementById('edit-mode').classList.add('hidden');
      showLocked();
    } catch (e) {
      errorEl.textContent = 'Connection error';
      errorEl.classList.remove('hidden');
    }
  });

  // Allow Enter key to submit
  document.getElementById('modal-password').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('modal-confirm').click();
    }
  });
}

// ---------------------------------------------------------------------------
// LOCKED MODE
// ---------------------------------------------------------------------------
function showLocked() {
  document.getElementById('locked-mode').classList.remove('hidden');
  document.getElementById('edit-mode').classList.add('hidden');
  updateLockedUI();
  buildTimeline();

  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(async () => {
    status = await fetch('/api/status').then(r => r.json());
    if (!status.active || !status.locked) {
      clearInterval(countdownInterval);
      location.reload();
      return;
    }
    updateLockedUI();
  }, 1000);
}

function updateLockedUI() {
  // End date
  if (schedule.lockEndDate) {
    const end = new Date(schedule.lockEndDate);
    document.getElementById('lock-end-date').textContent = `Until ${end.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`;
  }

  // Progress
  if (status.dayProgress) {
    const { dayNum, totalDays, percent } = status.dayProgress;
    document.getElementById('day-progress-text').textContent = `Day ${dayNum} of ${totalDays}`;
    document.getElementById('day-progress-pct').textContent = `${percent}%`;
    document.getElementById('progress-fill').style.width = `${percent}%`;
  }

  // Curfew status
  const statusEl = document.getElementById('current-status');
  const countdownEl = document.getElementById('countdown');
  const streakEl = document.getElementById('streak');

  if (status.curfewInfo) {
    if (status.curfewInfo.curfewActive) {
      statusEl.className = 'status-indicator curfew';
      statusEl.textContent = '🔴 CURFEW ACTIVE';
      countdownEl.className = 'countdown curfew';
      const mins = status.curfewInfo.minsUntilEnd;
      countdownEl.textContent = formatCountdown(mins);
    } else {
      statusEl.className = 'status-indicator free';
      statusEl.textContent = '🟢 Free';
      countdownEl.className = 'countdown free';
      const mins = status.curfewInfo.minsUntilStart;
      countdownEl.textContent = formatCountdown(mins);
    }
  }

  if (status.dayProgress) {
    const nights = Math.max(0, status.dayProgress.dayNum - 1);
    streakEl.textContent = nights > 0 ? `You've survived ${nights} night${nights !== 1 ? 's' : ''} 💪` : 'First night ahead — you got this';
  }
}

function formatCountdown(totalMins) {
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
}

function buildTimeline() {
  const container = document.getElementById('timeline');
  container.innerHTML = '';
  const nowDay = status.currentDay;
  const nowMin = (() => {
    const parts = status.currentTime.split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  })();

  DAYS.forEach(day => {
    const s = schedule.days[day];
    if (!s) return;
    const row = document.createElement('div');
    row.className = 'timeline-row';

    const startMin = timeToMin(s.curfewStart);
    const endMin = timeToMin(s.curfewEnd);

    let barHTML = '';
    if (startMin > endMin) {
      // Overnight: two blocks
      const startPct = (startMin / 1440) * 100;
      const endPct = (endMin / 1440) * 100;
      barHTML = `<div class="timeline-curfew" style="left:${startPct}%;right:0"></div>`;
      barHTML += `<div class="timeline-curfew" style="left:0;width:${endPct}%"></div>`;
    } else {
      const startPct = (startMin / 1440) * 100;
      const widthPct = ((endMin - startMin) / 1440) * 100;
      barHTML = `<div class="timeline-curfew" style="left:${startPct}%;width:${widthPct}%"></div>`;
    }

    // Now indicator
    let nowHTML = '';
    if (day === nowDay) {
      const nowPct = (nowMin / 1440) * 100;
      nowHTML = `<div class="timeline-now" style="left:${nowPct}%"></div>`;
    }

    row.innerHTML = `
      <div class="timeline-label">${DAY_SHORT[day]}</div>
      <div class="timeline-bar">${barHTML}${nowHTML}</div>`;
    container.appendChild(row);
  });
}

function timeToMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// FOCUS MODE
// ---------------------------------------------------------------------------
let selectedFocusMin = 0;
let focusInterval = null;

function setupFocus() {
  document.querySelectorAll('.focus-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.focus-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedFocusMin = parseInt(btn.dataset.min);
      document.getElementById('focus-start-btn').disabled = false;
    });
  });

  document.getElementById('custom-focus-min')?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value);
    if (v > 0) {
      document.querySelectorAll('.focus-btn').forEach(b => b.classList.remove('active'));
      selectedFocusMin = v;
      document.getElementById('focus-start-btn').disabled = false;
    }
  });

  document.getElementById('focus-start-btn')?.addEventListener('click', async () => {
    if (!selectedFocusMin) return;
    const res = await fetch('/api/focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: selectedFocusMin })
    });
    const data = await res.json();
    if (res.ok) {
      showFocusActive(data.focus);
    } else {
      alert(data.error || 'Failed');
    }
  });
}

function showFocusActive(focus) {
  document.getElementById('edit-mode').classList.add('hidden');
  document.getElementById('locked-mode').classList.add('hidden');
  document.getElementById('focus-mode').classList.remove('hidden');

  const endTime = new Date(focus.endTime).getTime();
  const startTime = new Date(focus.startTime).getTime();
  const totalMs = endTime - startTime;

  if (focusInterval) clearInterval(focusInterval);
  focusInterval = setInterval(() => {
    const now = Date.now();
    const remaining = Math.max(0, endTime - now);
    const elapsed = now - startTime;
    const pct = Math.min(100, (elapsed / totalMs) * 100);

    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    document.getElementById('focus-timer').textContent =
      `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
    document.getElementById('focus-progress-fill').style.width = `${pct}%`;

    if (remaining <= 0) {
      clearInterval(focusInterval);
      document.getElementById('focus-timer').textContent = '✅ Done!';
      document.getElementById('focus-label').textContent = 'Focus session complete';
      setTimeout(() => {
        document.getElementById('focus-mode').classList.add('hidden');
        showEdit();
      }, 3000);
    }
  }, 1000);
}

// ---------------------------------------------------------------------------
init();
