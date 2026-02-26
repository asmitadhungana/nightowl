const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 10;

const app = express();
const PORT = 8899;
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');
const LOCK_PASSWORD_FILE = path.join(__dirname, '.lock-password');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Schedule helpers
// ---------------------------------------------------------------------------
const DEFAULT_SCHEDULE = {
  active: false,
  lockPeriodDays: null,
  lockStartDate: null,
  lockEndDate: null,
  days: {
    monday:    { curfewStart: "22:00", curfewEnd: "06:00" },
    tuesday:   { curfewStart: "22:00", curfewEnd: "06:00" },
    wednesday: { curfewStart: "22:00", curfewEnd: "06:00" },
    thursday:  { curfewStart: "22:00", curfewEnd: "06:00" },
    friday:    { curfewStart: "22:00", curfewEnd: "06:00" },
    saturday:  { curfewStart: "22:00", curfewEnd: "06:00" },
    sunday:    { curfewStart: "22:00", curfewEnd: "06:00" }
  },
  timezone: "Asia/Kathmandu"
};

function loadSchedule() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading schedule:', e.message);
  }
  // Create default
  saveSchedule(DEFAULT_SCHEDULE);
  return { ...DEFAULT_SCHEDULE };
}

function saveSchedule(schedule) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
}

function getLockPasswordHash() {
  try {
    return fs.readFileSync(LOCK_PASSWORD_FILE, 'utf8').trim();
  } catch (e) {
    return null;
  }
}

async function setLockPassword(plainPassword) {
  const hash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
  fs.writeFileSync(LOCK_PASSWORD_FILE, hash);
  return hash;
}

async function verifyLockPassword(plainPassword) {
  const hash = getLockPasswordHash();
  if (!hash) return false;
  return bcrypt.compare(plainPassword, hash);
}

function isLocked(schedule) {
  if (!schedule.active || !schedule.lockEndDate) return false;
  const now = new Date();
  const end = new Date(schedule.lockEndDate);
  return now < end;
}

// Get current time in configured timezone
function getNowInTZ(tz) {
  return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
}

function getDayName(date) {
  return ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][date.getDay()];
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function isCurfewActive(schedule) {
  if (!schedule.active) return false;
  const now = getNowInTZ(schedule.timezone);
  const day = getDayName(now);
  const daySchedule = schedule.days[day];
  if (!daySchedule) return false;

  const currentMin = now.getHours() * 60 + now.getMinutes();
  const startMin = timeToMinutes(daySchedule.curfewStart);
  const endMin = timeToMinutes(daySchedule.curfewEnd);

  if (startMin > endMin) {
    // Overnight
    return currentMin >= startMin || currentMin < endMin;
  } else {
    return currentMin >= startMin && currentMin < endMin;
  }
}

function getNextCurfewInfo(schedule) {
  if (!schedule.active) return null;
  const now = getNowInTZ(schedule.timezone);
  const day = getDayName(now);
  const daySchedule = schedule.days[day];
  if (!daySchedule) return null;

  const currentMin = now.getHours() * 60 + now.getMinutes();
  const startMin = timeToMinutes(daySchedule.curfewStart);
  const endMin = timeToMinutes(daySchedule.curfewEnd);

  const curfewActive = (startMin > endMin)
    ? (currentMin >= startMin || currentMin < endMin)
    : (currentMin >= startMin && currentMin < endMin);

  if (curfewActive) {
    // Time until curfew ends
    let minsUntilEnd;
    if (startMin > endMin) {
      minsUntilEnd = currentMin >= startMin
        ? (1440 - currentMin + endMin)
        : (endMin - currentMin);
    } else {
      minsUntilEnd = endMin - currentMin;
    }
    return { curfewActive: true, minsUntilEnd, minsUntilStart: 0, curfewEnd: daySchedule.curfewEnd };
  } else {
    // Time until curfew starts
    let minsUntilStart;
    if (currentMin < startMin) {
      minsUntilStart = startMin - currentMin;
    } else {
      minsUntilStart = 1440 - currentMin + startMin;
    }
    return { curfewActive: false, minsUntilStart, minsUntilEnd: 0, curfewStart: daySchedule.curfewStart };
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/api/schedule', (req, res) => {
  res.json(loadSchedule());
});

app.post('/api/schedule', (req, res) => {
  const current = loadSchedule();
  if (isLocked(current)) {
    return res.status(403).json({ error: 'Schedule is locked until ' + current.lockEndDate });
  }

  const { days, lockPeriodDays, timezone } = req.body;
  if (days) current.days = days;
  if (lockPeriodDays) current.lockPeriodDays = lockPeriodDays;
  if (timezone) current.timezone = timezone;

  // Don't activate yet — just save the draft
  current.active = false;
  current.lockStartDate = null;
  current.lockEndDate = null;

  saveSchedule(current);
  res.json({ ok: true, schedule: current });
});

app.post('/api/activate', async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Password required (min 4 characters)' });
  }

  const schedule = loadSchedule();
  if (isLocked(schedule)) {
    return res.status(400).json({ error: 'Already locked' });
  }
  if (!schedule.lockPeriodDays) {
    return res.status(400).json({ error: 'No lock period set' });
  }

  // Hash and store the password
  await setLockPassword(password);

  const now = new Date();
  const end = new Date(now.getTime() + schedule.lockPeriodDays * 86400000);
  schedule.active = true;
  schedule.lockStartDate = now.toISOString();
  schedule.lockEndDate = end.toISOString();

  saveSchedule(schedule);
  res.json({ ok: true, schedule });
});

// Password verification endpoint for CLI
app.post('/api/verify-password', async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }
  const valid = await verifyLockPassword(password);
  res.json({ valid });
});

app.get('/api/status', (req, res) => {
  const schedule = loadSchedule();
  const locked = isLocked(schedule);
  const curfewInfo = getNextCurfewInfo(schedule);
  const now = getNowInTZ(schedule.timezone);

  let dayProgress = null;
  if (locked) {
    const start = new Date(schedule.lockStartDate);
    const end = new Date(schedule.lockEndDate);
    const totalMs = end - start;
    const elapsedMs = new Date() - start;
    const dayNum = Math.floor(elapsedMs / 86400000) + 1;
    const totalDays = schedule.lockPeriodDays;
    dayProgress = { dayNum, totalDays, percent: Math.min(100, Math.round((elapsedMs / totalMs) * 100)) };
  }

  // Check if lock period expired
  if (schedule.active && !locked) {
    schedule.active = false;
    schedule.lockStartDate = null;
    schedule.lockEndDate = null;
    schedule.lockPeriodDays = null;
    saveSchedule(schedule);
  }

  res.json({
    active: schedule.active && locked,
    locked,
    curfewInfo,
    dayProgress,
    currentTime: now.toLocaleTimeString('en-US', { hour12: false }),
    currentDay: getDayName(now),
    timezone: schedule.timezone,
    lockEndDate: schedule.lockEndDate
  });
});

// ---------------------------------------------------------------------------
// Focus Mode — quick lock for X minutes, today only
// ---------------------------------------------------------------------------
app.post('/api/focus', (req, res) => {
  const { minutes } = req.body;
  if (!minutes || minutes < 1 || minutes > 480) {
    return res.status(400).json({ error: 'Minutes must be between 1 and 480' });
  }

  const schedule = loadSchedule();
  // Don't allow focus mode during an active lock period's curfew
  if (schedule.active && isLocked(schedule) && isCurfewActive(schedule)) {
    return res.status(400).json({ error: 'Already in curfew' });
  }

  const now = new Date();
  const end = new Date(now.getTime() + minutes * 60000);

  // Store focus session separately
  const focusFile = path.join(__dirname, 'focus.json');
  const focus = {
    active: true,
    startTime: now.toISOString(),
    endTime: end.toISOString(),
    minutes
  };
  fs.writeFileSync(focusFile, JSON.stringify(focus, null, 2));
  res.json({ ok: true, focus });
});

app.get('/api/focus', (req, res) => {
  const focusFile = path.join(__dirname, 'focus.json');
  try {
    if (fs.existsSync(focusFile)) {
      const focus = JSON.parse(fs.readFileSync(focusFile, 'utf8'));
      if (focus.active && new Date() > new Date(focus.endTime)) {
        focus.active = false;
        fs.writeFileSync(focusFile, JSON.stringify(focus, null, 2));
      }
      const remaining = focus.active ? Math.max(0, Math.ceil((new Date(focus.endTime) - new Date()) / 1000)) : 0;
      return res.json({ ...focus, remainingSeconds: remaining });
    }
  } catch (e) {}
  res.json({ active: false });
});

app.post('/api/focus/cancel', (req, res) => {
  // Focus CANNOT be cancelled — that's the point
  res.status(403).json({ error: "Nice try. No cancelling focus mode. 🦉" });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`NightOwl server running on http://localhost:${PORT}`);
  // Ensure schedule.json exists
  loadSchedule();
});
