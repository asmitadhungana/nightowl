/**
 * NightOwl Desktop - Renderer
 * UI logic for the Electron app
 */

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_SHORT = { monday: 'MON', tuesday: 'TUE', wednesday: 'WED', thursday: 'THU', friday: 'FRI', saturday: 'SAT', sunday: 'SUN' };

let schedule = null;
let status = null;
let selectedDays = 7;
let countdownInterval = null;
let selectedFocusMin = 0;
let focusInterval = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  try {
    schedule = await window.nightowl.getSchedule();
    status = await window.nightowl.getStatus();
    const focus = await window.nightowl.getFocus();

    document.getElementById('loading').classList.add('hidden');

    // Check daemon status
    checkDaemonStatus();

    if (focus.active) {
      showFocusActive(focus);
    } else if (status.active && status.locked) {
      showLocked();
    } else {
      showEdit();
      setupFocus();
    }
    setupPasswordModal();
  } catch (error) {
    console.error('Init error:', error);
    document.getElementById('loading').innerHTML = `
      <div class="owl-icon">🦉</div>
      <p>Error loading: ${error.message}</p>
    `;
  }
}

// ---------------------------------------------------------------------------
// Daemon Status
// ---------------------------------------------------------------------------
async function checkDaemonStatus() {
  const indicator = document.getElementById('daemon-indicator');
  const text = document.getElementById('daemon-text');
  const installBtn = document.getElementById('daemon-install-btn');

  try {
    const status = await window.nightowl.getDaemonStatus();

    if (status.running) {
      indicator.className = 'indicator running';
      text.textContent = 'Daemon running';
      installBtn.classList.add('hidden');
    } else if (status.installed) {
      indicator.className = 'indicator installed';
      text.textContent = 'Daemon installed (not running)';
      installBtn.classList.add('hidden');
    } else {
      indicator.className = 'indicator not-installed';
      text.textContent = 'Daemon not installed';
      installBtn.classList.remove('hidden');
    }
  } catch (error) {
    indicator.className = 'indicator error';
    text.textContent = 'Could not check daemon status';
    installBtn.classList.remove('hidden');
  }

  installBtn.onclick = async () => {
    installBtn.disabled = true;
    installBtn.textContent = 'Installing...';

    try {
      const result = await window.nightowl.installDaemon();
      if (result.ok) {
        checkDaemonStatus();
      } else {
        alert('Installation failed: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      alert('Installation failed: ' + error.message);
    }

    installBtn.disabled = false;
    installBtn.textContent = 'Install Daemon';
  };
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
    await window.nightowl.saveSchedule({
      days,
      lockPeriodDays: selectedDays,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kathmandu'
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
      const result = await window.nightowl.activateSchedule({ password });
      if (!result.ok) {
        errorEl.textContent = result.error || 'Failed to lock';
        errorEl.classList.remove('hidden');
        return;
      }
      hidePasswordModal();
      schedule = result.schedule;
      status = await window.nightowl.getStatus();
      document.getElementById('edit-mode').classList.add('hidden');
      showLocked();
    } catch (e) {
      errorEl.textContent = 'Error: ' + e.message;
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
    status = await window.nightowl.getStatus();
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
    streakEl.textContent = nights > 0 ? `You've survived ${nights} night${nights !== 1 ? 's' : ''}` : 'First night ahead - you got this';
  }
}

function formatCountdown(totalMins) {
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
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
function setupFocus() {
  document.querySelectorAll('.focus-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.focus-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedFocusMin = parseInt(btn.dataset.min);
      document.getElementById('focus-start-btn').disabled = false;
    });
  });

  const customFocusInput = document.getElementById('custom-focus-min');
  if (customFocusInput) {
    customFocusInput.addEventListener('input', (e) => {
      const v = parseInt(e.target.value);
      if (v > 0) {
        document.querySelectorAll('.focus-btn').forEach(b => b.classList.remove('active'));
        selectedFocusMin = v;
        document.getElementById('focus-start-btn').disabled = false;
      }
    });
  }

  const focusStartBtn = document.getElementById('focus-start-btn');
  if (focusStartBtn) {
    focusStartBtn.addEventListener('click', async () => {
      if (!selectedFocusMin) return;
      try {
        const result = await window.nightowl.startFocus({ minutes: selectedFocusMin });
        if (result.ok) {
          showFocusActive(result.focus);
        } else {
          alert(result.error || 'Failed to start focus');
        }
      } catch (e) {
        alert('Error: ' + e.message);
      }
    });
  }
}

function showFocusActive(focus) {
  document.getElementById('edit-mode').classList.add('hidden');
  document.getElementById('locked-mode').classList.add('hidden');
  document.getElementById('focus-mode').classList.remove('hidden');

  const endTime = new Date(focus.endTime).getTime();
  const startTime = new Date(focus.startTime).getTime();
  const totalMs = endTime - startTime;

  if (focusInterval) clearInterval(focusInterval);
  focusInterval = setInterval(async () => {
    const now = Date.now();
    const remaining = Math.max(0, endTime - now);
    const elapsed = now - startTime;
    const pct = Math.min(100, (elapsed / totalMs) * 100);

    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    document.getElementById('focus-timer').textContent =
      `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    document.getElementById('focus-progress-fill').style.width = `${pct}%`;

    if (remaining <= 0) {
      clearInterval(focusInterval);
      document.getElementById('focus-timer').textContent = 'Done!';
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
