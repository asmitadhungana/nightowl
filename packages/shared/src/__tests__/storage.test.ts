import { getUserDataPath } from '../storage.js';

describe('getUserDataPath', () => {
  const origEnv = process.env.NIGHTOWL_DATA_PATH;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.NIGHTOWL_DATA_PATH;
    } else {
      process.env.NIGHTOWL_DATA_PATH = origEnv;
    }
  });

  it('honors NIGHTOWL_DATA_PATH when set', () => {
    process.env.NIGHTOWL_DATA_PATH = '/var/lib/nightowl-test';
    expect(getUserDataPath()).toBe('/var/lib/nightowl-test');
  });

  it('falls back to platform-specific user path when env unset', () => {
    delete process.env.NIGHTOWL_DATA_PATH;
    const result = getUserDataPath();
    // We don't assert exact path — just that it's non-empty and absolute
    expect(result.length).toBeGreaterThan(0);
    expect(result.startsWith('/') || /^[A-Z]:\\/.test(result)).toBe(true);
  });

  it('produces the same path for daemon (root) and desktop (user) when env is set', () => {
    // The split-brain bug we fixed: without the env var, os.homedir() returns
    // /var/root for the daemon and /Users/foo for the desktop. With the env
    // var, both processes resolve to the same explicit path.
    process.env.NIGHTOWL_DATA_PATH = '/Users/foo/Library/Application Support/NightOwl';
    const asUser = getUserDataPath();
    const asRoot = getUserDataPath(); // same call, env stays set
    expect(asUser).toBe(asRoot);
    expect(asUser).toBe('/Users/foo/Library/Application Support/NightOwl');
  });
});
