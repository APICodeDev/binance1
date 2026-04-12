import http2 from 'node:http2';
import crypto from 'node:crypto';

type APNSNotificationInput = {
  deviceToken: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: string;
  badge?: number;
  environment?: 'sandbox' | 'production';
};

const APNS_TEAM_ID = process.env.APPLE_TEAM_ID || '';
const APNS_KEY_ID = process.env.APPLE_KEY_ID || '';
const APNS_PRIVATE_KEY = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const APNS_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || process.env.IOS_BUNDLE_ID || '';

const base64url = (value: string | Buffer) =>
  Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

function createProviderToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: APNS_KEY_ID }));
  const payload = base64url(JSON.stringify({ iss: APNS_TEAM_ID, iat: now }));
  const signer = crypto.createSign('sha256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(APNS_PRIVATE_KEY);
  return `${header}.${payload}.${base64url(signature)}`;
}

export function isAPNSConfigured() {
  return Boolean(APNS_TEAM_ID && APNS_KEY_ID && APNS_PRIVATE_KEY && APNS_BUNDLE_ID);
}

export async function sendAPNSNotification(input: APNSNotificationInput) {
  if (!isAPNSConfigured()) {
    throw new Error('APNs is not configured.');
  }

  const authority = input.environment === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
  const client = http2.connect(authority);

  const payload = {
    aps: {
      alert: {
        title: input.title,
        body: input.body,
      },
      sound: input.sound || 'default',
      ...(typeof input.badge === 'number' ? { badge: input.badge } : {}),
    },
    ...(input.data || {}),
  };

  await new Promise<void>((resolve, reject) => {
    client.on('error', reject);

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${input.deviceToken}`,
      authorization: `bearer ${createProviderToken()}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'content-type': 'application/json',
    });

    let statusCode = 0;
    let responseBody = '';

    req.on('response', (headers) => {
      statusCode = Number(headers[':status'] || 0);
    });

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      responseBody += chunk;
    });
    req.on('end', () => {
      client.close();
      if (statusCode >= 200 && statusCode < 300) {
        resolve();
        return;
      }

      try {
        const parsed = responseBody ? JSON.parse(responseBody) : null;
        reject(new Error(parsed?.reason || `APNs request failed with status ${statusCode}`));
      } catch {
        reject(new Error(responseBody || `APNs request failed with status ${statusCode}`));
      }
    });
    req.on('error', (error) => {
      client.close();
      reject(error);
    });

    req.end(JSON.stringify(payload));
  });
}
