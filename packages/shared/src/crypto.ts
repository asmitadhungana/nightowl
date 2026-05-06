/**
 * NightOwl Crypto Utilities
 * Password hashing with bcrypt
 */

import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 10;

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(plainPassword: string, hash: string): Promise<boolean> {
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
