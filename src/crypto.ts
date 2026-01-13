import crypto from 'crypto';
import querystring from 'querystring';

import { constants } from './constants.js';

// ============================================================================
// Constants
// ============================================================================

const PADDING = Buffer.from('05', 'hex');
const BLOCK_SIZE = 16;

// ============================================================================
// Ford (Lock) API Signatures
// ============================================================================

/**
 * Create signature for Ford (Lock) API requests
 */
export function fordCreateSignature(urlPath: string, requestMethod: string, payload: Record<string, unknown>): string {
  let stringBuf = requestMethod + urlPath;

  Object.keys(payload)
    .sort()
    .forEach((key) => {
      stringBuf += `${key}=${payload[key]}&`;
    });

  stringBuf = stringBuf.slice(0, -1);
  stringBuf += constants.fordAppSecret;

  const urlencoded = querystring.escape(stringBuf);
  return crypto.createHash('md5').update(urlencoded).digest('hex');
}

// ============================================================================
// Olive (Thermostat) API Signatures
// ============================================================================

/**
 * Create signature for Olive (Thermostat) API requests
 * Handles both object payloads and string payloads
 */
export function oliveCreateSignature(payload: Record<string, unknown> | string, accessToken: string): string {
  let body: string;

  if (typeof payload === 'object') {
    body = Object.keys(payload)
      .sort()
      .map((key) => `${key}=${payload[key]}`)
      .join('&');
  } else {
    body = payload;
  }

  const accessKey = `${accessToken}${constants.oliveSigningSecret}`;
  const secret = crypto.createHash('md5').update(accessKey).digest('hex');

  return crypto.createHmac('md5', secret).update(body).digest('hex');
}

// ============================================================================
// AES Encryption/Decryption (for local device communication)
// ============================================================================

/**
 * Pad plaintext to be multiples of 16-byte blocks
 */
function pad(plainText: string): Buffer {
  let raw = Buffer.from(plainText, 'ascii');
  const padNum = BLOCK_SIZE - (raw.length % BLOCK_SIZE);
  const padBuffer = Buffer.alloc(padNum, PADDING);

  raw = Buffer.concat([raw, padBuffer]);
  return raw;
}

/**
 * Encrypt text using AES-128-CBC
 * Uses the key as both the encryption key and IV (Wyze-specific behavior)
 */
export function wyzeEncrypt(key: string, text: string): string {
  const raw = pad(text);
  const keyBuffer = Buffer.from(key, 'ascii');
  const iv = keyBuffer; // Wyze uses the secret key for the IV as well

  const cipher = crypto.createCipheriv('aes-128-cbc', keyBuffer, iv);
  let enc = cipher.update(raw);
  enc = Buffer.concat([enc, cipher.final()]);

  let b64Enc = enc.toString('base64');
  b64Enc = b64Enc.replace(/\//g, '\\/');

  return b64Enc;
}

/**
 * Decrypt text using AES-128-CBC
 * Uses the key as both the decryption key and IV (Wyze-specific behavior)
 */
export function wyzeDecrypt(key: string, enc: string): string {
  const encBuffer = Buffer.from(enc, 'base64');
  const keyBuffer = Buffer.from(key, 'ascii');
  const iv = keyBuffer;

  const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuffer, iv);
  let decrypt = decipher.update(encBuffer);
  decrypt = Buffer.concat([decrypt, decipher.final()]);

  const decryptTxt = decrypt.toString('ascii').replace(/\x05/g, '');
  return decryptTxt;
}

// ============================================================================
// Password Hashing
// ============================================================================

/**
 * Create password hash using triple MD5
 * This is Wyze's password hashing algorithm
 */
export function createPassword(password: string): string {
  const hex1 = crypto.createHash('md5').update(password).digest('hex');
  const hex2 = crypto.createHash('md5').update(hex1).digest('hex');
  const finalHash = crypto.createHash('md5').update(hex2).digest('hex');

  return finalHash;
}

// ============================================================================
// Legacy exports (for backward compatibility)
// ============================================================================

// Alias for snake_case naming convention
export const ford_create_signature = fordCreateSignature;
export const olive_create_signature = oliveCreateSignature;

// Additional legacy alias
export function oliveCreateSignatureSingle(payload: string, accessToken: string): string {
  return oliveCreateSignature(payload, accessToken);
}
