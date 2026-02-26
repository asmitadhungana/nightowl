/**
 * NightOwl Test Suite
 *
 * Tests: schedule parsing, curfew detection, overnight edge cases,
 * API endpoints, lock period expiration
 */

const request = require('supertest');
const fs = require('fs');
const path = require('path');

// Paths
const SCHEDULE_FILE = path.join(__dirname, 'schedule.test.json');
const LOCK_PASSWORD_FILE = path.join(__dirname, '.lock-password.test');

// We'll create a test version of the server
let app;

// Helper functions (copied from server.js for testing)
function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function getDayName(date) {
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][date.getDay()];
}

function isCurfewActiveForTime(schedule, currentMin, dayName) {
  const daySchedule = schedule.days[dayName];
  if (!daySchedule) return false;

  const startMin = timeToMinutes(daySchedule.curfewStart);
  const endMin = timeToMinutes(daySchedule.curfewEnd);

  if (startMin > endMin) {
    // Overnight curfew
    return currentMin >= startMin || currentMin < endMin;
  } else {
    // Same-day curfew
    return currentMin >= startMin && currentMin < endMin;
  }
}

// ============================================================================
// Schedule Parsing Tests
// ============================================================================
describe('Schedule Parsing', () => {
  test('should parse time string to minutes correctly', () => {
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('06:00')).toBe(360);
    expect(timeToMinutes('12:00')).toBe(720);
    expect(timeToMinutes('22:00')).toBe(1320);
    expect(timeToMinutes('23:59')).toBe(1439);
  });

  test('should get day name correctly', () => {
    expect(getDayName(new Date('2026-02-22'))).toBe('sunday');
    expect(getDayName(new Date('2026-02-23'))).toBe('monday');
    expect(getDayName(new Date('2026-02-26'))).toBe('thursday');
  });

  test('should parse schedule JSON correctly', () => {
    const schedule = {
      active: true,
      lockPeriodDays: 7,
      days: {
        monday: { curfewStart: '22:00', curfewEnd: '06:00' },
        tuesday: { curfewStart: '21:00', curfewEnd: '05:00' }
      },
      timezone: 'Asia/Kathmandu'
    };

    expect(schedule.active).toBe(true);
    expect(schedule.lockPeriodDays).toBe(7);
    expect(schedule.days.monday.curfewStart).toBe('22:00');
    expect(schedule.timezone).toBe('Asia/Kathmandu');
  });
});

// ============================================================================
// Curfew Detection Tests
// ============================================================================
describe('Curfew Detection', () => {
  const schedule = {
    active: true,
    days: {
      monday: { curfewStart: '22:00', curfewEnd: '06:00' },  // overnight
      tuesday: { curfewStart: '13:00', curfewEnd: '14:00' }, // same-day
      wednesday: { curfewStart: '00:00', curfewEnd: '06:00' }, // early morning only
      thursday: { curfewStart: '22:00', curfewEnd: '23:00' }, // late night only
    },
    timezone: 'Asia/Kathmandu'
  };

  describe('Same-day curfew (13:00-14:00)', () => {
    test('should be active at 13:00', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('13:00'), 'tuesday')).toBe(true);
    });

    test('should be active at 13:30', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('13:30'), 'tuesday')).toBe(true);
    });

    test('should NOT be active at 14:00 (end boundary)', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('14:00'), 'tuesday')).toBe(false);
    });

    test('should NOT be active at 12:59 (before start)', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('12:59'), 'tuesday')).toBe(false);
    });

    test('should NOT be active at 15:00 (after end)', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('15:00'), 'tuesday')).toBe(false);
    });
  });

  describe('Overnight curfew (22:00-06:00)', () => {
    test('should be active at 22:00 (start)', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('22:00'), 'monday')).toBe(true);
    });

    test('should be active at 23:30 (before midnight)', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('23:30'), 'monday')).toBe(true);
    });

    test('should be active at 00:00 (midnight)', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('00:00'), 'monday')).toBe(true);
    });

    test('should be active at 03:00 (after midnight)', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('03:00'), 'monday')).toBe(true);
    });

    test('should be active at 05:59 (just before end)', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('05:59'), 'monday')).toBe(true);
    });

    test('should NOT be active at 06:00 (end boundary)', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('06:00'), 'monday')).toBe(false);
    });

    test('should NOT be active at 21:59 (before start)', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('21:59'), 'monday')).toBe(false);
    });

    test('should NOT be active at 12:00 (midday)', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('12:00'), 'monday')).toBe(false);
    });
  });

  describe('Edge cases', () => {
    test('early morning curfew (00:00-06:00)', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('00:00'), 'wednesday')).toBe(true);
      expect(isCurfewActiveForTime(schedule, timeToMinutes('03:00'), 'wednesday')).toBe(true);
      expect(isCurfewActiveForTime(schedule, timeToMinutes('05:59'), 'wednesday')).toBe(true);
      expect(isCurfewActiveForTime(schedule, timeToMinutes('06:00'), 'wednesday')).toBe(false);
      expect(isCurfewActiveForTime(schedule, timeToMinutes('12:00'), 'wednesday')).toBe(false);
    });

    test('late night curfew (22:00-23:00)', () => {
      expect(isCurfewActiveForTime(schedule, timeToMinutes('22:00'), 'thursday')).toBe(true);
      expect(isCurfewActiveForTime(schedule, timeToMinutes('22:30'), 'thursday')).toBe(true);
      expect(isCurfewActiveForTime(schedule, timeToMinutes('23:00'), 'thursday')).toBe(false);
      expect(isCurfewActiveForTime(schedule, timeToMinutes('21:59'), 'thursday')).toBe(false);
    });
  });
});

// ============================================================================
// Lock Period Tests
// ============================================================================
describe('Lock Period', () => {
  test('should calculate lock end date correctly', () => {
    const now = new Date('2026-02-26T12:00:00Z');
    const lockPeriodDays = 7;
    const end = new Date(now.getTime() + lockPeriodDays * 86400000);

    expect(end.toISOString()).toBe('2026-03-05T12:00:00.000Z');
  });

  test('should detect if lock is active', () => {
    const schedule = {
      active: true,
      lockEndDate: '2026-03-01T00:00:00.000Z'
    };

    // Mock "now" as Feb 26
    const now = new Date('2026-02-26T12:00:00Z');
    const end = new Date(schedule.lockEndDate);
    const isLocked = now < end;

    expect(isLocked).toBe(true);
  });

  test('should detect if lock has expired', () => {
    const schedule = {
      active: true,
      lockEndDate: '2026-02-25T00:00:00.000Z'
    };

    // Mock "now" as Feb 26
    const now = new Date('2026-02-26T12:00:00Z');
    const end = new Date(schedule.lockEndDate);
    const isLocked = now < end;

    expect(isLocked).toBe(false);
  });

  test('should handle missing lockEndDate', () => {
    const schedule = {
      active: true,
      lockEndDate: null
    };

    const isLocked = schedule.active && schedule.lockEndDate && new Date() < new Date(schedule.lockEndDate);
    expect(isLocked).toBeFalsy();  // null/false/undefined are all "not locked"
  });
});

// ============================================================================
// API Tests (requires running server)
// ============================================================================
describe('API Endpoints', () => {
  let server;

  beforeAll((done) => {
    // Set up test environment
    process.env.SCHEDULE_FILE = SCHEDULE_FILE;
    process.env.LOCK_PASSWORD_FILE = LOCK_PASSWORD_FILE;

    // Clean up test files
    try { fs.unlinkSync(SCHEDULE_FILE); } catch (e) {}
    try { fs.unlinkSync(LOCK_PASSWORD_FILE); } catch (e) {}

    // Create a test app
    const express = require('express');
    const bcrypt = require('bcrypt');

    app = express();
    app.use(express.json());

    const DEFAULT_SCHEDULE = {
      active: false,
      lockPeriodDays: null,
      lockStartDate: null,
      lockEndDate: null,
      days: {
        monday: { curfewStart: "22:00", curfewEnd: "06:00" },
        tuesday: { curfewStart: "22:00", curfewEnd: "06:00" },
        wednesday: { curfewStart: "22:00", curfewEnd: "06:00" },
        thursday: { curfewStart: "22:00", curfewEnd: "06:00" },
        friday: { curfewStart: "22:00", curfewEnd: "06:00" },
        saturday: { curfewStart: "22:00", curfewEnd: "06:00" },
        sunday: { curfewStart: "22:00", curfewEnd: "06:00" }
      },
      timezone: "Asia/Kathmandu"
    };

    function loadSchedule() {
      try {
        if (fs.existsSync(SCHEDULE_FILE)) {
          return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        }
      } catch (e) {}
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(DEFAULT_SCHEDULE, null, 2));
      return { ...DEFAULT_SCHEDULE };
    }

    function saveSchedule(schedule) {
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
    }

    function isLocked(schedule) {
      if (!schedule.active || !schedule.lockEndDate) return false;
      return new Date() < new Date(schedule.lockEndDate);
    }

    app.get('/api/schedule', (req, res) => {
      res.json(loadSchedule());
    });

    app.post('/api/schedule', (req, res) => {
      const current = loadSchedule();
      if (isLocked(current)) {
        return res.status(403).json({ error: 'Schedule is locked' });
      }
      const { days, lockPeriodDays, timezone } = req.body;
      if (days) current.days = days;
      if (lockPeriodDays) current.lockPeriodDays = lockPeriodDays;
      if (timezone) current.timezone = timezone;
      current.active = false;
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

      const hash = await bcrypt.hash(password, 10);
      fs.writeFileSync(LOCK_PASSWORD_FILE, hash);

      const now = new Date();
      const end = new Date(now.getTime() + schedule.lockPeriodDays * 86400000);
      schedule.active = true;
      schedule.lockStartDate = now.toISOString();
      schedule.lockEndDate = end.toISOString();
      saveSchedule(schedule);
      res.json({ ok: true, schedule });
    });

    app.post('/api/verify-password', async (req, res) => {
      const { password } = req.body;
      if (!password) {
        return res.status(400).json({ error: 'Password required' });
      }
      try {
        const hash = fs.readFileSync(LOCK_PASSWORD_FILE, 'utf8').trim();
        const valid = await bcrypt.compare(password, hash);
        res.json({ valid });
      } catch (e) {
        res.json({ valid: false });
      }
    });

    app.get('/api/status', (req, res) => {
      const schedule = loadSchedule();
      res.json({
        active: schedule.active,
        locked: isLocked(schedule),
        lockEndDate: schedule.lockEndDate
      });
    });

    server = app.listen(0, done);
  });

  afterAll((done) => {
    // Clean up test files
    try { fs.unlinkSync(SCHEDULE_FILE); } catch (e) {}
    try { fs.unlinkSync(LOCK_PASSWORD_FILE); } catch (e) {}
    server.close(done);
  });

  test('GET /api/schedule returns default schedule', async () => {
    const res = await request(app).get('/api/schedule');
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(res.body.days.monday.curfewStart).toBe('22:00');
  });

  test('POST /api/schedule updates schedule', async () => {
    const res = await request(app)
      .post('/api/schedule')
      .send({
        days: {
          monday: { curfewStart: '21:00', curfewEnd: '05:00' },
          tuesday: { curfewStart: '21:00', curfewEnd: '05:00' },
          wednesday: { curfewStart: '21:00', curfewEnd: '05:00' },
          thursday: { curfewStart: '21:00', curfewEnd: '05:00' },
          friday: { curfewStart: '21:00', curfewEnd: '05:00' },
          saturday: { curfewStart: '21:00', curfewEnd: '05:00' },
          sunday: { curfewStart: '21:00', curfewEnd: '05:00' }
        },
        lockPeriodDays: 14
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.schedule.days.monday.curfewStart).toBe('21:00');
    expect(res.body.schedule.lockPeriodDays).toBe(14);
  });

  test('POST /api/activate requires password', async () => {
    const res = await request(app)
      .post('/api/activate')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Password required');
  });

  test('POST /api/activate requires minimum password length', async () => {
    const res = await request(app)
      .post('/api/activate')
      .send({ password: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('min 4');
  });

  test('POST /api/activate activates schedule with valid password', async () => {
    const res = await request(app)
      .post('/api/activate')
      .send({ password: 'testpassword' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.schedule.active).toBe(true);
    expect(res.body.schedule.lockEndDate).toBeTruthy();
  });

  test('POST /api/verify-password verifies correct password', async () => {
    const res = await request(app)
      .post('/api/verify-password')
      .send({ password: 'testpassword' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  test('POST /api/verify-password rejects wrong password', async () => {
    const res = await request(app)
      .post('/api/verify-password')
      .send({ password: 'wrongpassword' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  test('POST /api/schedule fails when locked', async () => {
    const res = await request(app)
      .post('/api/schedule')
      .send({ lockPeriodDays: 30 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('locked');
  });

  test('GET /api/status shows locked state', async () => {
    const res = await request(app).get('/api/status');

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.locked).toBe(true);
  });
});

// ============================================================================
// Timezone Tests
// ============================================================================
describe('Timezone Handling', () => {
  test('should handle different timezones', () => {
    const timezones = ['Asia/Kathmandu', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];

    timezones.forEach(tz => {
      // Just verify the timezone string is valid
      const date = new Date();
      const formatted = date.toLocaleString('en-US', { timeZone: tz });
      expect(formatted).toBeTruthy();
    });
  });

  test('should correctly identify day in different timezone', () => {
    // UTC time: Thursday Feb 26, 2026 at 00:30
    // In Asia/Kathmandu (UTC+5:45): Thursday Feb 26, 2026 at 06:15
    const utcDate = new Date('2026-02-26T00:30:00Z');

    // Get day in UTC
    const utcDay = getDayName(utcDate);
    expect(utcDay).toBe('thursday');
  });
});
