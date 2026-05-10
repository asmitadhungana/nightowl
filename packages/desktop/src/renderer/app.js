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
let daemonRunning = false;
let lockMode = 'self';                 // 'self' | 'friend'
let friendlockStatus = null;            // last DelegationStatus from main
let friendlockCountdownInterval = null;
let friendlockUnsubscribers = [];

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  try {
    schedule = await window.nightowl.getSchedule();
    status = await window.nightowl.getStatus();
    const focus = await window.nightowl.getFocus();
    friendlockStatus = await window.nightowl.friendlock.getStatus();

    document.getElementById('loading').classList.add('hidden');

    // Check daemon status
    checkDaemonStatus();
    subscribeFriendlockEvents();

    if (focus.active) {
      showFocusActive(focus);
    } else if (status.active && status.locked) {
      showLocked();
    } else {
      showEdit();
      setupFocus();

      // If we're mid-pairing (e.g. user closed the app and reopened), resume the modal.
      if (friendlockStatus.delegated && friendlockStatus.phase &&
          ['enrolled','paired','awaiting_password'].includes(friendlockStatus.phase)) {
        resumeFriendlockModal();
      }
    }
    setupPasswordModal();
    setupFriendlockModal();
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
    daemonRunning = !!status.running;

    if (status.running) {
      indicator.className = 'indicator running';
      text.textContent = 'Daemon running — enforcement active';
      installBtn.classList.add('hidden');
    } else if (status.installed) {
      indicator.className = 'indicator installed';
      text.textContent = 'Daemon installed but NOT running — click Reinstall';
      installBtn.textContent = 'Reinstall Daemon';
      installBtn.classList.remove('hidden');
    } else {
      indicator.className = 'indicator not-installed';
      text.textContent = 'Daemon not installed — focus & lock will NOT enforce';
      installBtn.textContent = 'Install Daemon';
      installBtn.classList.remove('hidden');
    }
  } catch (error) {
    daemonRunning = false;
    indicator.className = 'indicator error';
    text.textContent = 'Could not check daemon status';
    installBtn.textContent = 'Install Daemon';
    installBtn.classList.remove('hidden');
  }
  applyDaemonGating();

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

function applyDaemonGating() {
  const lockBtn = document.getElementById('lock-btn');
  const focusBtn = document.getElementById('focus-start-btn');
  if (lockBtn) {
    if (!daemonRunning) {
      lockBtn.disabled = true;
      lockBtn.title = 'Daemon not running — install it first or no enforcement will happen';
    } else {
      lockBtn.title = '';
      updateLockBtn();
    }
  }
  if (focusBtn) {
    if (!daemonRunning) {
      focusBtn.disabled = true;
      focusBtn.title = 'Daemon not running — install it first or no enforcement will happen';
    } else {
      focusBtn.title = '';
      if (selectedFocusMin > 0) focusBtn.disabled = false;
    }
  }
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
  setupLockModeToggle();
}

function setupLockModeToggle() {
  const radios = document.querySelectorAll('input[name="lock-mode"]');
  radios.forEach(r => {
    r.addEventListener('change', (e) => {
      lockMode = e.target.value;
      // Update the lock button label so the user knows what'll happen on click.
      const btn = document.getElementById('lock-btn');
      if (btn) {
        btn.textContent = lockMode === 'friend' ? '🔒 Set up Friend Lock' : '🔒 Lock It In';
      }
    });
  });
  // Reflect initial state.
  const btn = document.getElementById('lock-btn');
  if (btn) btn.textContent = lockMode === 'friend' ? '🔒 Set up Friend Lock' : '🔒 Lock It In';
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
  document.getElementById('lock-btn').disabled = selectedDays < 1 || !daemonRunning;
}

function setupLockButton() {
  document.getElementById('lock-btn').addEventListener('click', async () => {
    if (!daemonRunning) {
      alert('Daemon not running. Install it first or no enforcement will happen.');
      return;
    }
    const days = getDaysFromUI();
    // Save schedule first
    const saveResult = await window.nightowl.saveSchedule({
      days,
      lockPeriodDays: selectedDays,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kathmandu'
    });
    if (!saveResult.ok) {
      alert(saveResult.error || 'Could not save schedule');
      return;
    }
    schedule = saveResult.schedule;

    if (lockMode === 'friend') {
      showFriendlockModal('a');
    } else {
      showPasswordModal();
    }
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
// FRIEND LOCK MODAL
// ---------------------------------------------------------------------------
function showFriendlockModal(state) {
  const overlay = document.getElementById('friendlock-overlay');
  overlay.classList.remove('hidden');
  showFriendlockState(state);
}

function hideFriendlockModal() {
  document.getElementById('friendlock-overlay').classList.add('hidden');
  if (friendlockCountdownInterval) {
    clearInterval(friendlockCountdownInterval);
    friendlockCountdownInterval = null;
  }
}

function showFriendlockState(state) {
  ['a', 'b', 'c'].forEach(s => {
    const el = document.getElementById(`friendlock-state-${s}`);
    if (el) el.classList.toggle('hidden', s !== state);
  });
}

function showFriendlockError(state, message) {
  const errEl = document.getElementById(`friendlock-error-${state}`);
  if (errEl) {
    errEl.textContent = message;
    errEl.classList.remove('hidden');
  }
}

function clearFriendlockError(state) {
  const errEl = document.getElementById(`friendlock-error-${state}`);
  if (errEl) errEl.classList.add('hidden');
}

function setupFriendlockModal() {
  document.getElementById('friendlock-cancel-a').addEventListener('click', async () => {
    hideFriendlockModal();
  });

  document.getElementById('friendlock-generate-btn').addEventListener('click', async () => {
    clearFriendlockError('a');
    const btn = document.getElementById('friendlock-generate-btn');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const res = await window.nightowl.friendlock.enroll();
      if (!res.ok) {
        showFriendlockError('a', res.error || 'Could not enroll');
        btn.disabled = false;
        btn.textContent = 'Generate Pair Code';
        return;
      }
      renderPairCode(res.pairCode, res.expiresAt);
      showFriendlockState('b');
    } catch (e) {
      showFriendlockError('a', 'Error: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate Pair Code';
    }
  });

  document.getElementById('friendlock-cancel-b').addEventListener('click', async () => {
    try {
      await window.nightowl.friendlock.cancelPairing();
    } catch (e) { /* ignore */ }
    hideFriendlockModal();
  });
}

function renderPairCode(code, expiresAtMs) {
  // Format like X4P-Q7M-2 for readability (8 chars → 3-3-2)
  const fmt = `${code.slice(0,3)}-${code.slice(3,6)}-${code.slice(6,8)}`;
  document.getElementById('friendlock-paircode').textContent = fmt;
  document.getElementById('friendlock-paircmd').textContent = `/pair ${code}`;

  if (friendlockCountdownInterval) clearInterval(friendlockCountdownInterval);
  const countdownEl = document.getElementById('friendlock-countdown');
  const tick = () => {
    const remainingMs = expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      countdownEl.textContent = 'Code expired. Generate a new one.';
      clearInterval(friendlockCountdownInterval);
      friendlockCountdownInterval = null;
      return;
    }
    const totalSec = Math.floor(remainingMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    countdownEl.textContent = `Code expires in ${m}:${String(s).padStart(2, '0')}`;
  };
  tick();
  friendlockCountdownInterval = setInterval(tick, 1000);
}

async function resumeFriendlockModal() {
  // We're mid-flow from a previous session. Render the appropriate state.
  // We don't have the original pair code in memory if the bot already paired —
  // skip B and jump to C (the user just waits for the password).
  if (friendlockStatus.phase === 'enrolled') {
    if (friendlockStatus.pairCode && friendlockStatus.pairCodeExpiresAt) {
      renderPairCode(friendlockStatus.pairCode, friendlockStatus.pairCodeExpiresAt);
      showFriendlockModal('b');
    } else {
      // Restart from scratch — original pair code is gone.
      showFriendlockModal('a');
    }
  } else if (friendlockStatus.phase === 'paired' || friendlockStatus.phase === 'awaiting_password') {
    showFriendlockModal('c');
    if (friendlockStatus.friendName) {
      document.getElementById('friendlock-friend-name').textContent = friendlockStatus.friendName;
      document.getElementById('friendlock-friend-name-2').textContent = friendlockStatus.friendName;
    }
  }
}

function subscribeFriendlockEvents() {
  // Clean up any prior subscriptions (e.g. on hot reload during dev).
  friendlockUnsubscribers.forEach(u => { try { u(); } catch (e) {} });
  friendlockUnsubscribers = [];

  friendlockUnsubscribers.push(
    window.nightowl.friendlock.onPhaseChange(async (phase) => {
      friendlockStatus = await window.nightowl.friendlock.getStatus();
      if (phase === 'awaiting_password') {
        showFriendlockState('c');
        if (friendlockStatus.friendName) {
          document.getElementById('friendlock-friend-name').textContent = friendlockStatus.friendName;
          document.getElementById('friendlock-friend-name-2').textContent = friendlockStatus.friendName;
        }
      } else if (phase === 'active') {
        // Lock just activated — close modal and transition to locked-mode.
        hideFriendlockModal();
        schedule = await window.nightowl.getSchedule();
        status = await window.nightowl.getStatus();
        document.getElementById('edit-mode').classList.add('hidden');
        showLocked();
      } else if (phase === null) {
        hideFriendlockModal();
      }
    })
  );

  friendlockUnsubscribers.push(
    window.nightowl.friendlock.onFriendPaired(({ friendName }) => {
      const statusEl = document.getElementById('friendlock-status-b');
      if (statusEl) statusEl.textContent = `Paired with ${friendName}. Asking them to set the password…`;
    })
  );

  friendlockUnsubscribers.push(
    window.nightowl.friendlock.onBotUnreachable(() => {
      // Surface the error in whichever state is currently open.
      ['a','b','c'].forEach(s => {
        const el = document.getElementById(`friendlock-state-${s}`);
        if (el && !el.classList.contains('hidden')) {
          showFriendlockError(s, 'Bot unreachable. Check NIGHTOWL_BOT_URL is set to your deployed Worker URL (see RUNBOOK.md §8) or your internet, then try again.');
        }
      });
    })
  );
}

// ---------------------------------------------------------------------------
// LOCKED MODE
// ---------------------------------------------------------------------------
function showLocked() {
  document.getElementById('locked-mode').classList.remove('hidden');
  document.getElementById('edit-mode').classList.add('hidden');
  updateLockedUI();
  buildTimeline();
  setupUninstallCard();
  refreshUninstallCard();

  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(async () => {
    status = await window.nightowl.getStatus();
    // Refresh schedule too — delegation.phase, friendRevokedAt, lastUninstallDecision
    // can all change under us when the bot pushes signed messages. Without this
    // the locked-screen UI stays frozen at the snapshot taken when showLocked() ran.
    schedule = await window.nightowl.getSchedule();
    if (!status.active || !status.locked) {
      clearInterval(countdownInterval);
      location.reload();
      return;
    }
    updateLockedUI();
    refreshUninstallCard();
  }, 1000);
}

function updateLockedUI() {
  // Delegation badge
  const badge = document.getElementById('delegation-badge');
  if (badge) {
    if (schedule.delegation && schedule.delegation.friendName) {
      badge.textContent = `🔒 Locked by ${schedule.delegation.friendName}`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

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
      document.getElementById('focus-start-btn').disabled = !daemonRunning;
    });
  });

  const customFocusInput = document.getElementById('custom-focus-min');
  if (customFocusInput) {
    customFocusInput.addEventListener('input', (e) => {
      const v = parseInt(e.target.value);
      if (v > 0) {
        document.querySelectorAll('.focus-btn').forEach(b => b.classList.remove('active'));
        selectedFocusMin = v;
        document.getElementById('focus-start-btn').disabled = !daemonRunning;
      }
    });
  }

  // Friend Focus toggle — only shown when a delegation/pairing exists. Without
  // a paired friend the option is meaningless (nobody to /approve), so we
  // hide it instead of showing a disabled checkbox.
  const friendToggle = document.getElementById('focus-friend-toggle');
  const friendNameSpan = document.getElementById('focus-friend-name');
  if (friendToggle) {
    if (schedule && schedule.delegation && schedule.delegation.friendName) {
      friendToggle.classList.remove('hidden');
      if (friendNameSpan) friendNameSpan.textContent = schedule.delegation.friendName;
    } else {
      friendToggle.classList.add('hidden');
    }
  }

  const focusStartBtn = document.getElementById('focus-start-btn');
  if (focusStartBtn) {
    focusStartBtn.addEventListener('click', async () => {
      if (!selectedFocusMin) return;
      if (!daemonRunning) {
        alert('Daemon not running. Install it first or your focus session will not enforce.');
        return;
      }
      const friendGated = !!document.getElementById('focus-friend-checkbox')?.checked;
      try {
        const result = await window.nightowl.startFocus({ minutes: selectedFocusMin, friendGated });
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

  // Friend Focus card — show only for friend-gated sessions.
  setupFocusReleaseCard();
  refreshFocusReleaseCard(focus);

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

    // Refresh the friend-release card every tick so /approve from Telegram
    // surfaces within ~1s of dispatch (and so a friend's early-release
    // approval flips the card from "Waiting…" to "End focus now").
    const liveFocus = await window.nightowl.getFocus();
    if (liveFocus && !liveFocus.active) {
      // Either timer expired OR user clicked End focus now from the card.
      // Either way, we're done — fall through to the standard "Done" branch.
    }
    refreshFocusReleaseCard(liveFocus || focus);

    if (remaining <= 0 || (liveFocus && !liveFocus.active)) {
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
// FRIEND LOCK — uninstall card on the locked screen
// ---------------------------------------------------------------------------
let uninstallCardWired = false;

function setupUninstallCard() {
  if (uninstallCardWired) return;
  uninstallCardWired = true;

  document.getElementById('friendlock-ask-friend-btn').onclick = async () => {
    const errEl = document.getElementById('friendlock-uninstall-error');
    errEl.classList.add('hidden');
    const r = await window.nightowl.friendlock.requestUninstall();
    if (!r.ok) {
      errEl.textContent = r.error || 'Could not send the request';
      errEl.classList.remove('hidden');
      return;
    }
    if (r.result === 'no_friend') {
      errEl.textContent = 'Your friend has not paired yet — nothing to ask.';
      errEl.classList.remove('hidden');
      return;
    }
    refreshUninstallCard();
  };

  document.getElementById('friendlock-cancel-request-btn').onclick = async () => {
    const errEl = document.getElementById('friendlock-uninstall-error');
    errEl.classList.add('hidden');
    const r = await window.nightowl.friendlock.cancelPendingUninstallRequest();
    if (!r.ok) {
      errEl.textContent = r.error || 'Could not cancel the request';
      errEl.classList.remove('hidden');
      return;
    }
    refreshUninstallCard();
  };

  document.getElementById('friendlock-emergency-btn').onclick = async () => {
    const errEl = document.getElementById('friendlock-uninstall-error');
    errEl.classList.add('hidden');
    const ok = window.confirm(
      'Start the 72-hour emergency cooldown?\n\nThis CANNOT be cancelled. After 72 hours, NightOwl will let you uninstall without your friend.\n\nUse this only if you genuinely need to escape the lock.'
    );
    if (!ok) return;
    const r = await window.nightowl.friendlock.startEmergencyCooldown();
    if (!r.ok) {
      errEl.textContent = r.error || 'Could not start cooldown';
      errEl.classList.remove('hidden');
      return;
    }
    refreshUninstallCard();
  };

  document.getElementById('friendlock-uninstall-now-btn').onclick = async () => {
    const errEl = document.getElementById('friendlock-uninstall-error');
    errEl.classList.add('hidden');
    const ok = window.confirm('Uninstall NightOwl daemon now? This ends the lock.');
    if (!ok) return;
    // password param ignored for delegated uninstall path
    const r = await window.nightowl.uninstallDaemon({ password: '' });
    if (!r.ok) {
      errEl.textContent = r.error || 'Uninstall failed';
      errEl.classList.remove('hidden');
      return;
    }
    location.reload();
  };

  // Live updates from main when a decision arrives or cooldown ticks.
  if (window.nightowl.friendlock.onUninstallDecision) {
    window.nightowl.friendlock.onUninstallDecision(() => refreshUninstallCard());
  }
  if (window.nightowl.friendlock.onEmergencyCooldownChanged) {
    window.nightowl.friendlock.onEmergencyCooldownChanged(() => refreshUninstallCard());
  }
}

async function refreshUninstallCard() {
  const card = document.getElementById('friendlock-uninstall-card');
  if (!card) return;

  // Show only when delegated. For self-set locks, the existing password-only
  // uninstall path is fine and lives outside this card.
  if (!schedule || !schedule.delegation) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  // Friend name in the button label.
  const nameEl = document.getElementById('friendlock-ask-friend-name');
  if (nameEl) nameEl.textContent = schedule.delegation.friendName || 'friend';

  let gateStatus;
  try {
    gateStatus = await window.nightowl.friendlock.getUninstallGate();
  } catch (e) {
    return;
  }

  const stateEl = document.getElementById('friendlock-uninstall-state');
  const askBtn = document.getElementById('friendlock-ask-friend-btn');
  const cancelBtn = document.getElementById('friendlock-cancel-request-btn');
  const emergBtn = document.getElementById('friendlock-emergency-btn');
  const nowBtn = document.getElementById('friendlock-uninstall-now-btn');

  // Reset every per-button bit so each tick computes a clean state. Without
  // this, e.g. `disabled = true; textContent = "Request pending…"` set on the
  // ask button when a request was in flight would persist across the deny that
  // came back, leaving the button stuck and unclickable.
  stateEl.className = 'uninstall-state';
  askBtn.classList.remove('hidden');
  askBtn.disabled = false;
  askBtn.textContent = `Ask ${schedule.delegation.friendName || 'friend'} to release`;
  cancelBtn.classList.add('hidden');
  emergBtn.classList.remove('hidden');
  emergBtn.disabled = false;
  emergBtn.textContent = 'Start 72h emergency cooldown';
  nowBtn.classList.add('hidden');

  // Cooldown in flight?
  if (gateStatus.emergencyCooldownStartedAt) {
    const remainingMs = gateStatus.emergencyCooldownRemainingMs;
    if (remainingMs > 0) {
      stateEl.classList.add('cooldown');
      stateEl.textContent = `Emergency cooldown in progress — ${formatHoursLeft(remainingMs)} remaining. NightOwl will allow uninstall when it elapses.`;
      emergBtn.disabled = true;
      emergBtn.textContent = 'Emergency cooldown in flight';
    } else {
      stateEl.classList.add('allowed');
      stateEl.textContent = 'Emergency cooldown elapsed. You may uninstall now.';
      emergBtn.classList.add('hidden');
      askBtn.classList.add('hidden');
      nowBtn.classList.remove('hidden');
    }
    return;
  }

  // Friend revoked? Two sub-cases — with or without a prior approval.
  // Past approvals stand: /revoke is forward-looking, the friend cannot
  // unilaterally retract a previously-issued approval (would defang the
  // asymmetry under social pressure). So if verdict was approved BEFORE
  // revoke, the user can still uninstall — just surface that the friend
  // has stepped away in addition to the prior approval.
  if (schedule.delegation.phase === 'revoked') {
    askBtn.classList.add('hidden');
    if (gateStatus.lastDecisionVerdict === 'approved') {
      stateEl.classList.add('allowed');
      stateEl.textContent = `${schedule.delegation.friendName || 'Your friend'} approved your earlier request and has now stepped away from this lock. Their approval still stands — you may uninstall now.`;
      emergBtn.classList.add('hidden');
      nowBtn.classList.remove('hidden');
    } else {
      stateEl.classList.add('denied');
      stateEl.textContent = `${schedule.delegation.friendName || 'Your friend'} stepped away from this lock. They will not approve uninstall — start the 72h emergency cooldown to escape.`;
    }
    return;
  }

  // Pending request?
  if (gateStatus.pendingUninstallReqId && !gateStatus.lastDecisionVerdict) {
    stateEl.textContent = `Waiting for ${schedule.delegation.friendName || 'your friend'} to /approve or /deny in Telegram.`;
    askBtn.disabled = true;
    askBtn.textContent = 'Request pending…';
    cancelBtn.classList.remove('hidden');
    return;
  }

  // Most recent decision was deny?
  if (gateStatus.lastDecisionVerdict === 'denied') {
    stateEl.classList.add('denied');
    stateEl.textContent = `${schedule.delegation.friendName || 'Your friend'} denied your last request. Try again or start the 72h emergency cooldown.`;
    return;
  }

  // Approved?
  if (gateStatus.gate.allowed) {
    stateEl.classList.add('allowed');
    stateEl.textContent = `${schedule.delegation.friendName || 'Your friend'} approved your uninstall request. You may uninstall now.`;
    askBtn.classList.add('hidden');
    emergBtn.classList.add('hidden');
    nowBtn.classList.remove('hidden');
    return;
  }

  // Default: nothing in flight.
  stateEl.textContent = 'No request in flight. Click "Ask … to release" to send your friend an /approve|/deny prompt on Telegram.';
}

function formatHoursLeft(ms) {
  if (ms <= 0) return '0h 0m';
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// FRIEND FOCUS — early-release card on the active focus screen (M7)
// ---------------------------------------------------------------------------
let focusReleaseCardWired = false;

function setupFocusReleaseCard() {
  if (focusReleaseCardWired) return;
  focusReleaseCardWired = true;

  document.getElementById('focus-ask-friend-btn').onclick = async () => {
    const errEl = document.getElementById('focus-release-error');
    errEl.classList.add('hidden');
    const r = await window.nightowl.friendlock.requestFocusRelease();
    if (!r.ok) {
      errEl.textContent = r.error || 'Could not send the request';
      errEl.classList.remove('hidden');
      return;
    }
    if (r.result === 'no_friend') {
      errEl.textContent = 'Your friend has not paired yet — nothing to ask.';
      errEl.classList.remove('hidden');
      return;
    }
    const liveFocus = await window.nightowl.getFocus();
    refreshFocusReleaseCard(liveFocus);
  };

  document.getElementById('focus-cancel-request-btn').onclick = async () => {
    const errEl = document.getElementById('focus-release-error');
    errEl.classList.add('hidden');
    const r = await window.nightowl.friendlock.cancelPendingFocusRelease();
    if (!r.ok) {
      errEl.textContent = r.error || 'Could not cancel the request';
      errEl.classList.remove('hidden');
      return;
    }
    const liveFocus = await window.nightowl.getFocus();
    refreshFocusReleaseCard(liveFocus);
  };

  document.getElementById('focus-end-now-btn').onclick = async () => {
    const errEl = document.getElementById('focus-release-error');
    errEl.classList.add('hidden');
    const ok = window.confirm('End the focus session now?');
    if (!ok) return;
    const r = await window.nightowl.friendlock.endFocusEarly();
    if (!r.ok) {
      errEl.textContent = r.error || 'Could not end focus';
      errEl.classList.remove('hidden');
      return;
    }
    // The 1s focus tick will see active=false and run the "Done" sequence.
  };

  if (window.nightowl.friendlock.onFocusReleaseDecision) {
    window.nightowl.friendlock.onFocusReleaseDecision(async () => {
      const liveFocus = await window.nightowl.getFocus();
      refreshFocusReleaseCard(liveFocus);
    });
  }
}

async function refreshFocusReleaseCard(focus) {
  const card = document.getElementById('focus-release-card');
  if (!card) return;

  // Solo focus → don't show the card at all. Same for ended/missing sessions.
  if (!focus || !focus.active || !focus.friendGated) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  let gateStatus;
  try {
    gateStatus = await window.nightowl.friendlock.getFocusReleaseGate();
  } catch (e) {
    return;
  }

  const stateEl = document.getElementById('focus-release-state');
  const askBtn = document.getElementById('focus-ask-friend-btn');
  const cancelBtn = document.getElementById('focus-cancel-request-btn');
  const endNowBtn = document.getElementById('focus-end-now-btn');
  const nameSpan = document.getElementById('focus-ask-friend-name');

  const friendName = gateStatus.friendName || 'friend';
  if (nameSpan) nameSpan.textContent = friendName;

  // Reset every per-button bit each tick so previous states don't stick.
  stateEl.className = 'uninstall-state';
  askBtn.classList.remove('hidden');
  askBtn.disabled = false;
  askBtn.textContent = `Ask ${friendName} to release`;
  cancelBtn.classList.add('hidden');
  endNowBtn.classList.add('hidden');

  // Pending request?
  if (gateStatus.pendingReleaseReqId && !gateStatus.lastDecisionVerdict) {
    stateEl.textContent = `Waiting for ${friendName} to /approve or /deny in Telegram.`;
    askBtn.disabled = true;
    askBtn.textContent = 'Request pending…';
    cancelBtn.classList.remove('hidden');
    return;
  }

  // Most recent decision was deny?
  if (gateStatus.lastDecisionVerdict === 'denied') {
    stateEl.classList.add('denied');
    stateEl.textContent = `${friendName} denied your last request. Try again or wait the timer out.`;
    return;
  }

  // Approved → show End focus now.
  if (gateStatus.gate.allowed) {
    stateEl.classList.add('allowed');
    stateEl.textContent = `${friendName} approved your release. You may end the focus session now.`;
    askBtn.classList.add('hidden');
    endNowBtn.classList.remove('hidden');
    return;
  }

  // Default: nothing in flight.
  stateEl.textContent = `Click "Ask ${friendName} to release" to send your friend an /approve|/deny prompt on Telegram.`;
}

// ---------------------------------------------------------------------------
init();
