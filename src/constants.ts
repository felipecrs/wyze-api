import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };

export interface WyzeConstants {
  // Crypto Secrets
  fordAppKey: string;
  fordAppSecret: string;
  oliveSigningSecret: string;
  oliveAppId: string;
  // Application Information
  appInfo: string;
  phoneId: string;
  appName: string;
  appVer: string;
  appVersion: string;
  sc: string;
  sv: string;
  authApiKey: string;
  userAgent: string;
  // Base URLs
  authBaseUrl: string;
  apiBaseUrl: string;
}

export const constants: Readonly<WyzeConstants> = Object.freeze({
  // Crypto Secrets (Required for device communication)
  fordAppKey: '275965684684dbdaf29a0ed9', // Required for Locks
  fordAppSecret: '4deekof1ba311c5c33a9cb8e12787e8c', // Required for Locks
  oliveSigningSecret: 'wyze_app_secret_key_132', // Required for the thermostat
  oliveAppId: '9319141212m2ik', // Required for the thermostat

  // Application Information (for emulation)
  appInfo: 'wyze_android_2.19.14', // Required for the thermostat
  phoneId: 'wyze_developer_api',
  appName: 'com.hualai.WyzeCam',
  appVer: 'wyze_developer_api',
  appVersion: 'wyze_developer_api',
  sc: 'wyze_developer_api',
  sv: 'wyze_developer_api',
  authApiKey: 'WMXHYf79Nr5gIlt3r0r7p9Tcw5bvs6BB4U8O8nGJ',
  userAgent: `unofficial-wyze-api/${packageJson.version}`,

  // Base URLs for API requests
  authBaseUrl: 'https://auth-prod.api.wyze.com',
  apiBaseUrl: 'https://api.wyzecam.com',
});

export default constants;
