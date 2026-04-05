import crypto from 'crypto';

export const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'bitget_dashboard_session';
export const AUTH_SESSION_TTL_HOURS = Number(process.env.AUTH_SESSION_TTL_HOURS || '168');
export const AUTH_API_TOKEN_TTL_DAYS = Number(process.env.AUTH_API_TOKEN_TTL_DAYS || '365');

export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function getSessionExpiry() {
  return new Date(Date.now() + AUTH_SESSION_TTL_HOURS * 60 * 60 * 1000);
}

export function getApiTokenExpiry() {
  return new Date(Date.now() + AUTH_API_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
