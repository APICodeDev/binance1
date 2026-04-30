import type { CapacitorConfig } from '@capacitor/cli';

const serverUrl = process.env.CAPACITOR_SERVER_URL?.trim() || 'http://localhost:3000';

const config: CapacitorConfig = {
  appId: 'com.bitgetdesk.dashboard',
  appName: 'Bitget Desk',
  webDir: '.next',
  server: {
    url: serverUrl,
    cleartext: serverUrl.startsWith('http://'),
    allowNavigation: [
      'localhost',
      'trades.apicode.cloud',
      '*.apicode.cloud',
    ],
  },
  ios: {
    contentInset: 'always',
  },
};

export default config;
