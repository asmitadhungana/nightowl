/**
 * NightOwl Crypto Utilities
 * Password hashing with bcrypt
 *
 * bcrypt is lazy-imported so consumers that never call hash/verify (notably
 * the daemon, which only reads schedule.json) can be bundled into a single
 * .exe via @yao-pkg/pkg without pulling in the bcrypt native binary.
 */

const BCRYPT_ROUNDS = 10;

type BcryptModule = {
  hash(plain: string, rounds: number): Promise<string>;
  compare(plain: string, hash: string): Promise<boolean>;
};

let cachedBcrypt: BcryptModule | null = null;

async function getBcrypt(): Promise<BcryptModule> {
  if (cachedBcrypt) return cachedBcrypt;
  const mod = await import('bcrypt');
  cachedBcrypt = (mod as unknown as { default?: BcryptModule }).default ?? (mod as unknown as BcryptModule);
  return cachedBcrypt;
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  const bcrypt = await getBcrypt();
  return bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(plainPassword: string, hash: string): Promise<boolean> {
  const bcrypt = await getBcrypt();
  return bcrypt.compare(plainPassword, hash);
}

/**
 * Validate password requirements
 */
export function validatePassword(password: string): { valid: boolean; error?: string } {
  if (!password) {
    return { valid: false, error: 'Password is required' };
  }
  if (password.length < 4) {
    return { valid: false, error: 'Password must be at least 4 characters' };
  }
  if (password.length > 100) {
    return { valid: false, error: 'Password must be less than 100 characters' };
  }
  return { valid: true };
}
