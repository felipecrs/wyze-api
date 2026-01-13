import { constants } from './constants.js';
import { fordCreateSignature } from './crypto.js';

// ============================================================================
// Payload Types
// ============================================================================

export interface FordPayload {
  accessToken: string;
  key: string;
  timestamp: string;
  sign: string;
  [key: string]: unknown;
}

export interface OliveGetPayload {
  keys: string;
  did: string;
  nonce: string;
  [key: string]: unknown;
}

export interface OlivePostPayload {
  did: string;
  model: string;
  props: Record<string, unknown>;
  is_sub_device: number;
  nonce: string;
  [key: string]: unknown;
}

export interface OliveHmsPayload {
  group_id: string;
  nonce: string;
  [key: string]: unknown;
}

export interface OliveUserInfoPayload {
  nonce: string;
  [key: string]: unknown;
}

export interface OliveHmsGetPayload {
  hms_id: string;
  nonce: string;
  [key: string]: unknown;
}

export interface OliveHmsPatchPayload {
  hms_id: string;
  [key: string]: unknown;
}

// ============================================================================
// Ford (Lock) API Payloads
// ============================================================================

/**
 * Create payload for Ford (Lock) API requests
 */
export function fordCreatePayload(
  accessToken: string,
  payload: Record<string, unknown>,
  urlPath: string,
  requestMethod: string,
): FordPayload {
  return {
    ...payload,
    accessToken,
    key: constants.fordAppKey,
    timestamp: Date.now().toString(),
    sign: fordCreateSignature(urlPath, requestMethod, payload),
  };
}

// ============================================================================
// Olive (Thermostat) API Payloads
// ============================================================================

/**
 * Create GET payload for Olive API
 */
export function oliveCreateGetPayload(deviceMac: string, keys: string): OliveGetPayload {
  return {
    keys,
    did: deviceMac,
    nonce: Date.now().toString(),
  };
}

/**
 * Create POST payload for Olive API
 */
export function oliveCreatePostPayload(deviceMac: string, deviceModel: string, propKey: string, value: unknown): OlivePostPayload {
  return {
    did: deviceMac,
    model: deviceModel,
    props: {
      [propKey]: value,
    },
    is_sub_device: 0,
    nonce: Date.now().toString(),
  };
}

// ============================================================================
// HMS (Home Monitoring System) Payloads
// ============================================================================

/**
 * Create HMS payload
 */
export function oliveCreateHmsPayload(): OliveHmsPayload {
  return {
    group_id: 'hms',
    nonce: Date.now().toString(),
  };
}

/**
 * Create user info payload
 */
export function oliveCreateUserInfoPayload(): OliveUserInfoPayload {
  return {
    nonce: Date.now().toString(),
  };
}

/**
 * Create HMS GET payload
 */
export function oliveCreateHmsGetPayload(hmsId: string): OliveHmsGetPayload {
  return {
    hms_id: hmsId,
    nonce: Date.now().toString(),
  };
}

/**
 * Create HMS PATCH payload
 */
export function oliveCreateHmsPatchPayload(hmsId: string): OliveHmsPatchPayload {
  return {
    hms_id: hmsId,
  };
}
