import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import getUuid from 'uuid-by-string';

import { constants } from './constants.js';
import * as crypto from './crypto.js';
import * as payloadFactory from './payloadFactory.js';
import { RokuAuthLib } from './rokuAuth.js';
import type {
  WyzeAPIOptions,
  WyzeApiResponse,
  WyzeDevice,
  WyzeDeviceListResponse,
  WyzePropertyListResponse,
} from './types.js';

import type { AxiosRequestConfig, AxiosResponse } from 'axios';

// ============================================================================
// Types
// ============================================================================

export interface Logger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  (...args: unknown[]): void;
}

interface RequestData {
  access_token: string;
  app_name: string;
  app_ver: string;
  app_version: string;
  phone_id: string;
  phone_system_type: string;
  sc: string;
  sv: string;
  ts: number;
  [key: string]: unknown;
}

interface ApiResult<T = unknown> {
  ok: boolean;
  data: WyzeApiResponse<T> | T;
  status?: number;
  headers?: unknown;
  error?: {
    retryAfter?: number;
    message: string;
    code?: number | string;
  };
}

interface PersistedTokens {
  access_token: string;
  refresh_token: string;
}

interface PropertyItem {
  pid: string;
  pvalue: string;
}

interface ActionListItem {
  instance_id: string;
  action_params: {
    list: {
      mac: string;
      plist: PropertyItem[];
    }[];
  };
  provider_key: string;
  action_key: string;
}

interface LocalBulbCharacteristics {
  mac: string;
  index: string;
  ts: number;
  plist: PropertyItem[];
}

// ============================================================================
// WyzeAPI Class
// ============================================================================

export class WyzeAPI {
  private log: Logger;
  private persistPath: string;
  private refreshTokenTimerEnabled: boolean;
  private lowBatteryPercentage: number;

  // User login parameters
  private username: string;
  private password: string;
  private mfaCode?: string;
  private apiKey?: string;
  private keyId?: string;

  // Logging
  private apiLogEnabled: boolean;

  // URLs
  private authBaseUrl: string;
  private apiBaseUrl: string;

  // App emulation constants
  private authApiKey: string;
  private phoneId: string;
  private appName: string;
  private appVer: string;
  private appVersion: string;
  private userAgent: string;
  private sc: string;
  private sv: string;

  // Crypto Secrets
  private fordAppKey: string;
  private fordAppSecret: string;
  private oliveSigningSecret: string;
  private oliveAppId: string;
  private appInfo: string;

  // Login tokens
  private access_token = '';
  private refresh_token = '';

  private dumpData = false;
  private lastLoginAttempt = 0;
  private loginAttemptDebounceMilliseconds = 1000;

  constructor(options: WyzeAPIOptions, log?: Logger) {
    this.log = log ?? (console as unknown as Logger);
    this.persistPath = options.persistPath ?? '';
    this.refreshTokenTimerEnabled = options.refreshTokenTimerEnabled ?? false;
    this.lowBatteryPercentage = options.lowBatteryPercentage ?? 30;

    // User login parameters
    this.username = options.username ?? '';
    this.password = options.password ?? '';
    this.mfaCode = options.mfaCode;
    this.apiKey = options.apiKey;
    this.keyId = options.keyId;

    // Logging
    this.apiLogEnabled = options.apiLogEnabled ?? false;

    // URLs
    this.authBaseUrl = options.authBaseUrl ?? constants.authBaseUrl;
    this.apiBaseUrl = options.apiBaseUrl ?? constants.apiBaseUrl;

    // App emulation constants
    this.authApiKey = options.authApiKey ?? constants.authApiKey;
    this.phoneId = options.phoneId ?? constants.phoneId;
    this.appName = options.appName ?? constants.appName;
    this.appVer = options.appVer ?? constants.appVer;
    this.appVersion = options.appVersion ?? constants.appVersion;
    this.userAgent = constants.userAgent;
    this.sc = options.sc ?? constants.sc;
    this.sv = options.sv ?? constants.sv;

    // Crypto Secrets
    this.fordAppKey = options.fordAppKey ?? constants.fordAppKey;
    this.fordAppSecret = options.fordAppSecret ?? constants.fordAppSecret;
    this.oliveSigningSecret = options.oliveSigningSecret ?? constants.oliveSigningSecret;
    this.oliveAppId = options.oliveAppId ?? constants.oliveAppId;
    this.appInfo = options.appInfo ?? constants.appInfo;

    // Token is good for 216,000 seconds (60 hours) but 48 hours seems like a reasonable refresh interval 172800
    if (this.refreshTokenTimerEnabled === true) {
      setInterval(this.refreshToken.bind(this), 172800);
    }
  }

  private getRequestData(data: Record<string, unknown> = {}): RequestData {
    return {
      access_token: this.access_token,
      app_name: this.appName,
      app_ver: this.appVer,
      app_version: this.appVersion,
      phone_id: this.phoneId,
      phone_system_type: '1',
      sc: this.sc,
      sv: this.sv,
      ts: new Date().getTime(),
      ...data,
    };
  }

  /**
   * Sends an HTTP request to the specified URL with the provided data.
   * Handles automatic retries in case of specific errors, such as a retry-after condition.
   */
  async request<T = unknown>(url: string, data: Record<string, unknown> = {}): Promise<ApiResult<T>> {
    await this.maybeLogin();
    return this._handleRequest<T>(url, data);
  }

  /**
   * Handles the request process, including retry logic for specific errors.
   */
  private async _handleRequest<T>(url: string, data: Record<string, unknown>): Promise<ApiResult<T>> {
    const response = await this._performRequest<T>(url, this.getRequestData(data));

    if (response.ok) {
      return response;
    }

    if (response.error?.retryAfter) {
      return this._handleRetry<T>(url, data, response.error);
    }

    throw new Error(`Request Failed: ${response.error?.message ?? 'Unknown Error'}`);
  }

  /**
   * Handles the retry logic if the request fails due to a retryAfter error.
   */
  private async _handleRetry<T>(
    url: string,
    data: Record<string, unknown>,
    error: { retryAfter?: number; message: string },
  ): Promise<ApiResult<T>> {
    this.log.error(`Error: ${error.message}. Retrying after ${new Date(error.retryAfter ?? 0)}`);

    const retryAfterMs = (error.retryAfter ?? 0) - new Date().getTime();
    if (retryAfterMs > 0) {
      this.log(`Waiting for ${retryAfterMs}ms before retrying`);
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    }

    await this.maybeLogin();

    const response = await this._performRequest<T>(url, this.getRequestData(data));

    if (response.ok) return response;

    throw new Error(`Error: ${response.error?.message ?? 'Request Failed After Retry'}`);
  }

  private async _performRequest<T>(
    url: string,
    data: Record<string, unknown> = {},
    config: Partial<AxiosRequestConfig> = {},
  ): Promise<ApiResult<T>> {
    const requestConfig: AxiosRequestConfig = {
      method: 'POST',
      url,
      data,
      baseURL: this.apiBaseUrl,
      ...config,
    };

    if (this.apiLogEnabled) {
      this.log(`Performing request: ${JSON.stringify(requestConfig)}`);
    }

    let result: AxiosResponse;
    try {
      result = await axios(requestConfig);
    } catch (err) {
      this._handleRequestError(err as Error, url);
      throw err;
    }

    this._logApiResponse(result, url);

    await this._checkRateLimit(result.headers as Record<string, string>);

    return this._handleApiResponse<T>(result, url, data);
  }

  private _handleRequestError(err: Error & { response?: AxiosResponse }, url: string): void {
    if (err.response) {
      this.log.error(
        `Request Failed: ${JSON.stringify({
          url,
          status: err.response.status,
          data: err.response.data,
          headers: err.response.headers,
        })}`,
      );
    } else {
      this.log.error(
        `Request Failed: ${JSON.stringify({
          url,
          message: err.message,
        })}`,
      );
    }
  }

  private _logApiResponse(result: AxiosResponse, url: string): void {
    if (this.dumpData) {
      this.dumpData = false;
      this.log(
        `API response PerformRequest: ${JSON.stringify(result.data, (key, val) =>
          key.includes('token') ? '*******' : val,
        )}`,
      );
    } else if (this.apiLogEnabled) {
      this.log(
        `API response PerformRequest: ${JSON.stringify({
          url,
          status: result.status,
          data: result.data,
          headers: result.headers,
        })}`,
      );
    }
  }

  private async _checkRateLimit(headers: Record<string, string>): Promise<void> {
    try {
      const rateLimitRemaining = headers['x-ratelimit-remaining'] ? Number(headers['x-ratelimit-remaining']) : undefined;

      const rateLimitResetBy = headers['x-ratelimit-reset-by']
        ? new Date(headers['x-ratelimit-reset-by']).getTime()
        : undefined;

      if (rateLimitRemaining !== undefined && rateLimitRemaining < 7 && rateLimitResetBy !== undefined) {
        const resetsIn = rateLimitResetBy - Date.now();
        this.log(`API rate limit remaining: ${rateLimitRemaining} - resets in ${resetsIn}ms`);
        await this.sleepMilliSeconds(resetsIn);
      } else if (rateLimitRemaining && this.apiLogEnabled && rateLimitResetBy !== undefined) {
        this.log(`API rate limit remaining: ${rateLimitRemaining}. Expires in ${rateLimitResetBy - Date.now()}ms`);
      }
    } catch (err) {
      this.log.error(`Error checking rate limit: ${err}`);
    }
  }

  private async _handleApiResponse<T>(
    result: AxiosResponse,
    url: string,
    data: Record<string, unknown>,
  ): Promise<ApiResult<T>> {
    const { code, msg, description } = result.data as { code?: number; msg?: string; description?: string };
    const errorMessage = msg ?? description ?? 'Unknown Wyze API Error';

    if (code !== 1) {
      this.log.error(`Wyze API Error (${code}): '${errorMessage}'`);

      if (this._isInvalidCredentialsError(errorMessage)) {
        this.access_token = '';
        throw new Error(
          `Invalid Credentials - please check your credentials & account before trying again. Error: ${errorMessage}`,
        );
      }

      if (this._isRateLimitError(code, errorMessage)) {
        return this._handleRateLimitError(result, errorMessage, code);
      }

      if (this._isAccessTokenError(code, errorMessage)) {
        return await this._handleAccessTokenError<T>(result, errorMessage, code);
      }

      if (this._isBadRequestError(code)) {
        throw new Error(
          `Wyze API Bad Request: Check your request parameters - ${JSON.stringify({
            code,
            message: errorMessage,
            url,
            requestBody: data,
          })}`,
        );
      }

      throw new Error(`Wyze API Error (${code}) - ${errorMessage}`);
    }

    return { ...result, ok: true, data: result.data };
  }

  private _isInvalidCredentialsError(errorMessage: string): boolean {
    const invalidMessages = ['UserNameOrPasswordError', 'UserIsLocked', 'Invalid User Name or Password'];
    return invalidMessages.some((msg) => errorMessage.toLowerCase().includes(msg.toLowerCase()));
  }

  private _isRateLimitError(code: number | undefined, errorMessage: string): boolean {
    return (
      code === 3044 || (code === 1000 && errorMessage.toLowerCase().includes('too many failed attempts'))
    );
  }

  private _handleRateLimitError<T>(
    result: AxiosResponse,
    errorMessage: string,
    code: number | undefined,
  ): ApiResult<T> {
    return {
      ...result,
      ok: false,
      data: result.data,
      error: {
        retryAfter: Date.now() + 600_000, // 10 minutes from now
        message: `Rate Limited - please wait before trying again. Error: ${errorMessage}`,
        code,
      },
    };
  }

  private _isAccessTokenError(code: number | undefined, errorMessage: string): boolean {
    return (
      code === 2001 ||
      errorMessage.toLowerCase().includes('accesstokenerror') ||
      errorMessage.toLowerCase().includes('access token is error')
    );
  }

  private async _handleAccessTokenError<T>(
    result: AxiosResponse,
    errorMessage: string,
    code: number | undefined,
  ): Promise<ApiResult<T>> {
    this.access_token = '';
    await this.refreshToken().catch((err: Error) => {
      throw new Error(`Refresh Token could not be used to get a new access token. ${err}`);
    });

    return {
      ...result,
      ok: false,
      data: result.data,
      error: {
        retryAfter: this.access_token ? Date.now() : 0,
        message: this.access_token
          ? 'Access Token had expired and a new one was obtained. Please retry your request.'
          : `Access Token Error - please refresh your access token. Error: ${errorMessage}`,
        code,
      },
    };
  }

  private _isBadRequestError(code: number | undefined): boolean {
    return code !== undefined && [1001, 1004].includes(code);
  }

  private _performLoginRequest(data: Record<string, unknown> = {}): Promise<ApiResult> {
    const url = 'api/user/login';
    const loginData = {
      email: this.username,
      password: crypto.createPassword(this.password),
      ...data,
    };

    const config: Partial<AxiosRequestConfig> = {
      baseURL: this.authBaseUrl,
      headers: {
        'x-api-key': this.authApiKey,
        apikey: this.apiKey,
        keyid: this.keyId,
        'User-Agent': this.userAgent,
      },
    };

    return this._performRequest(url, loginData, config);
  }

  async login(): Promise<void> {
    if (this.apiKey == null) {
      throw new Error('ApiKey Required, Please provide the "apiKey" parameter in config.json');
    } else if (this.keyId == null) {
      throw new Error('KeyId Required, Please provide the "keyId" parameter in config.json');
    } else {
      const result = await this._performLoginRequest();
      const loginData = result.data as { access_token?: string; refresh_token?: string };
      if (!result.ok || !loginData.access_token) {
        throw new Error(`Invalid credentials, please check username/password, keyId/apiKey - ${JSON.stringify(result)}`);
      }
      if (this.apiLogEnabled) {
        this.log('Successfully logged into Wyze API');
      }
      await this._updateTokens({
        access_token: loginData.access_token,
        refresh_token: loginData.refresh_token ?? '',
      });
    }
  }

  /**
   * Ensures that the user is logged in by checking and managing the access token.
   */
  async maybeLogin(): Promise<void> {
    if (!this.access_token) {
      await this._loadPersistedTokens();
    }

    if (this.access_token) {
      return;
    }

    const now = Date.now();
    this.logDebounceInfo(now);

    if (this.isDebounceCleared(now)) {
      this.resetDebounceIfNeeded(now);
      await this.tryLogin(now);
    } else {
      await this.waitForDebounceClearance();

      if (!this.access_token) {
        await this.updateDebounceAndLogin(now);
      }
    }
  }

  private logDebounceInfo(now: number): void {
    if (this.apiLogEnabled) {
      this.log(
        `Last login: ${this.lastLoginAttempt}, Debounce: ${this.loginAttemptDebounceMilliseconds} ms, Now: ${now}`,
      );
    }
  }

  private isDebounceCleared(now: number): boolean {
    return this.lastLoginAttempt + this.loginAttemptDebounceMilliseconds < now;
  }

  private resetDebounceIfNeeded(now: number): void {
    const debounceThreshold = 12 * 60 * 60 * 1000; // 12 hours in milliseconds
    if (now - this.lastLoginAttempt > debounceThreshold) {
      this.loginAttemptDebounceMilliseconds = 1000;
    }
  }

  private async tryLogin(now: number): Promise<void> {
    this.lastLoginAttempt = now;
    await this.login();
  }

  private async waitForDebounceClearance(): Promise<void> {
    this.log(
      `Attempting to login before debounce has cleared, waiting ${this.loginAttemptDebounceMilliseconds / 1000} seconds`,
    );

    let waitTime = 0;
    while (waitTime < this.loginAttemptDebounceMilliseconds) {
      await this.sleepSeconds(2);
      waitTime += 2000;
      if (this.access_token) {
        return;
      }
    }
  }

  private async updateDebounceAndLogin(now: number): Promise<void> {
    this.lastLoginAttempt = now;
    this.loginAttemptDebounceMilliseconds = Math.min(
      this.loginAttemptDebounceMilliseconds * 2,
      5 * 60 * 1000, // Cap the debounce time to 5 minutes
    );
    await this.login();
  }

  /**
   * Refreshes the access token using the refresh token.
   */
  async refreshToken(): Promise<void> {
    const data = {
      ...this.getRequestData(),
      refresh_token: this.refresh_token,
    };

    const maxRetries = 2;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        const result = await this._performRequest('app/user/refresh_token', data);
        const responseData = result.data as { data?: PersistedTokens };

        if (result.ok && responseData?.data) {
          await this._updateTokens(responseData.data);
          return;
        } else {
          throw new Error(`Failed to refresh access token - ${JSON.stringify(result)}`);
        }
      } catch (error) {
        attempt += 1;
        if (attempt < maxRetries) {
          this.log(`Retrying token refresh, attempt ${attempt}...`);
          await this.sleepSeconds(2);
        } else {
          this.log(`Error during token refresh: ${(error as Error).message}`);
          throw new Error(`Token refresh failed: ${(error as Error).message}`);
        }
      }
    }
  }

  /**
   * Updates the access and refresh tokens with new values.
   */
  private async _updateTokens({ access_token, refresh_token }: PersistedTokens): Promise<void> {
    try {
      this.access_token = access_token;
      this.refresh_token = refresh_token;
      await this._persistTokens();
    } catch (error) {
      this.log(`Error updating tokens: ${(error as Error).message}`);
      throw new Error(`Failed to update tokens: ${(error as Error).message}`);
    }
  }

  private _tokenPersistPath(): string {
    const uuid = getUuid(this.username);
    if (!uuid) {
      throw new Error('Failed to generate UUID for token persistence path.');
    }
    return path.join(this.persistPath, `wyze-${uuid}.json`);
  }

  private async _persistTokens(): Promise<void> {
    const data = {
      access_token: this.access_token,
      refresh_token: this.refresh_token,
    };
    const tokenPath = this._tokenPersistPath();

    const maxRetries = 2;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        if (this.apiLogEnabled) {
          this.log(`Persisting tokens @ ${tokenPath}`);
        }
        await fs.writeFile(tokenPath, JSON.stringify(data));
        return;
      } catch (error) {
        attempt += 1;
        if (attempt < maxRetries) {
          this.log(`Retrying token persistence, attempt ${attempt}...`);
          await this.sleepSeconds(2);
        } else {
          this.log(`Error persisting tokens: ${(error as Error).message}`);
          throw new Error(`Failed to persist tokens: ${(error as Error).message}`);
        }
      }
    }
  }

  private async _loadPersistedTokens(): Promise<void> {
    const tokenPath = this._tokenPersistPath();

    try {
      const data = await fs.readFile(tokenPath, 'utf-8');
      const parsedData = JSON.parse(data) as PersistedTokens;

      if (parsedData.access_token && parsedData.refresh_token) {
        this.access_token = parsedData.access_token;
        this.refresh_token = parsedData.refresh_token;
      } else {
        throw new Error('Persisted tokens are invalid.');
      }
    } catch (error) {
      if (this.apiLogEnabled) {
        this.log(`Error loading persisted tokens: ${(error as Error).message}`);
      }
    }
  }

  // ============================================================================
  // Device API Methods
  // ============================================================================

  async getObjectList(): Promise<WyzeApiResponse<WyzeDeviceListResponse>> {
    const result = await this.request<WyzeDeviceListResponse>('app/v2/home_page/get_object_list');
    return result.data as WyzeApiResponse<WyzeDeviceListResponse>;
  }

  async getPropertyList(deviceMac: string, deviceModel: string): Promise<WyzeApiResponse<WyzePropertyListResponse>> {
    const data = {
      device_mac: deviceMac,
      device_model: deviceModel,
    };

    const result = await this.request<WyzePropertyListResponse>('app/v2/device/get_property_list', data);
    return result.data as WyzeApiResponse<WyzePropertyListResponse>;
  }

  async setProperty(
    deviceMac: string,
    deviceModel: string,
    propertyId: string,
    propertyValue: string | number,
  ): Promise<WyzeApiResponse> {
    const data = {
      device_mac: deviceMac,
      device_model: deviceModel,
      pid: propertyId,
      pvalue: propertyValue,
    };

    const result = await this.request('app/v2/device/set_property', data);
    return result.data as WyzeApiResponse;
  }

  async runAction(deviceMac: string, deviceModel: string, actionKey: string): Promise<WyzeApiResponse> {
    const data = {
      instance_id: deviceMac,
      provider_key: deviceModel,
      action_key: actionKey,
      action_params: {},
      custom_string: '',
    };

    if (this.apiLogEnabled) {
      this.log(`run_action Data Body: ${JSON.stringify(data)}`);
    }

    const result = await this.request('app/v2/auto/run_action', data);
    return result.data as WyzeApiResponse;
  }

  async runActionList(
    deviceMac: string,
    deviceModel: string,
    propertyId: string,
    propertyValue: string | number,
    actionKey: string,
  ): Promise<WyzeApiResponse> {
    const plist: PropertyItem[] = [{ pid: propertyId, pvalue: String(propertyValue) }];

    if (propertyId !== 'P3') {
      plist.push({ pid: 'P3', pvalue: '1' });
    }

    const data = {
      action_list: [
        {
          instance_id: deviceMac,
          action_params: {
            list: [{ mac: deviceMac, plist }],
          },
          provider_key: deviceModel,
          action_key: actionKey,
        } as ActionListItem,
      ],
    };

    if (this.apiLogEnabled) {
      this.log(`runActionList Request Data: ${JSON.stringify(data)}`);
    }

    const result = await this.request('app/v2/auto/run_action_list', data);
    return result.data as WyzeApiResponse;
  }

  // ============================================================================
  // Lock API Methods
  // ============================================================================

  async controlLock(deviceMac: string, deviceModel: string, action: string): Promise<unknown> {
    await this.maybeLogin();

    const urlPath = '/openapi/lock/v1/control';
    const uuid = this.getUuid(deviceMac, deviceModel);
    let payload: Record<string, unknown> = {
      uuid,
      action,
    };

    try {
      payload = payloadFactory.fordCreatePayload(this.access_token, payload, urlPath, 'post');

      const url = 'https://yd-saas-toc.wyzecam.com/openapi/lock/v1/control';
      const result = await axios.post(url, payload);

      if (this.apiLogEnabled) {
        this.log(`API response ControlLock: ${JSON.stringify(result.data)}`);
      }

      return result.data;
    } catch (error) {
      const err = error as Error & { response?: AxiosResponse };
      this.log.error(`Request failed: ${err.message}`);

      if (err.response) {
        this.log.error(
          `Response ControlLock (${err.response.status} - ${err.response.statusText}): ${JSON.stringify(err.response.data, null, 2)}`,
        );
      }

      throw error;
    }
  }

  async getLockInfo(deviceMac: string, deviceModel: string): Promise<unknown> {
    await this.maybeLogin();
    const urlPath = '/openapi/lock/v1/info';
    let payload: Record<string, unknown> = {
      uuid: this.getUuid(deviceMac, deviceModel),
      with_keypad: '1',
    };
    try {
      const config = {
        params: payload,
      };
      payload = payloadFactory.fordCreatePayload(this.access_token, payload, urlPath, 'get');

      const url = 'https://yd-saas-toc.wyzecam.com/openapi/lock/v1/info';
      const result = await axios.get(url, config);
      if (this.apiLogEnabled) {
        this.log(`API response GetLockInfo: ${JSON.stringify(result.data)}`);
      }
      return result.data;
    } catch (e) {
      const err = e as Error & { response?: AxiosResponse };
      this.log.error(`Request failed: ${err}`);
      if (err.response) {
        this.log.error(
          `Response GetLockInfo (${err.response.statusText}): ${JSON.stringify(err.response.data, null, '\t')}`,
        );
      }
      throw e;
    }
  }

  // ============================================================================
  // IoT Property Methods
  // ============================================================================

  async getIotProp(deviceMac: string): Promise<unknown> {
    const keys =
      'iot_state,switch-power,switch-iot,single_press_type,double_press_type,triple_press_type,long_press_type';

    await this.maybeLogin();

    const payload = payloadFactory.oliveCreateGetPayload(deviceMac, keys);
    const signature = crypto.oliveCreateSignature(payload, this.access_token);

    const config = {
      headers: {
        'Accept-Encoding': 'gzip',
        'User-Agent': this.userAgent,
        appid: constants.oliveAppId,
        appinfo: constants.appInfo,
        phoneid: this.phoneId,
        access_token: this.access_token,
        signature2: signature,
      },
      params: payload,
    };

    const url = 'https://wyze-sirius-service.wyzecam.com/plugin/sirius/get_iot_prop';

    if (this.apiLogEnabled) {
      this.log(`Performing request: ${url}`);
    }

    try {
      const result = await axios.get(url, config);

      if (this.apiLogEnabled) {
        this.log(`API response GetIotProp: ${JSON.stringify(result.data)}`);
      }

      return result.data;
    } catch (error) {
      const err = error as Error & { response?: AxiosResponse };
      this.log.error(`Request failed: ${err.message}`);

      if (err.response) {
        this.log.error(
          `Response GetIotProp (${err.response.statusText}): ${JSON.stringify(err.response.data, null, 2)}`,
        );
      }

      throw error;
    }
  }

  async setIotProp(deviceMac: string, productModel: string, propKey: string, value: unknown): Promise<unknown> {
    await this.maybeLogin();
    const payload = payloadFactory.oliveCreatePostPayload(deviceMac, productModel, propKey, value);
    const signature = crypto.oliveCreateSignatureSingle(JSON.stringify(payload), this.access_token);

    const config = {
      headers: {
        'Accept-Encoding': 'gzip',
        'Content-Type': 'application/json',
        'User-Agent': 'myapp',
        appid: constants.oliveAppId,
        appinfo: constants.appInfo,
        phoneid: this.phoneId,
        access_token: this.access_token,
        signature2: signature,
      },
    };

    try {
      const url = 'https://wyze-sirius-service.wyzecam.com/plugin/sirius/set_iot_prop_by_topic';
      const result = await axios.post(url, JSON.stringify(payload), config);
      if (this.apiLogEnabled) {
        this.log(`API response SetIotProp: ${JSON.stringify(result.data)}`);
      }

      return result.data;
    } catch (e) {
      const err = e as Error & { response?: AxiosResponse };
      this.log.error(`Request failed: ${err}`);
      if (err.response) {
        this.log.error(
          `Response SetIotProp (${err.response.statusText}): ${JSON.stringify(err.response.data, null, '\t')}`,
        );
      }
      throw e;
    }
  }

  // ============================================================================
  // User Profile Methods
  // ============================================================================

  async getUserProfile(): Promise<unknown> {
    await this.maybeLogin();

    const payload = payloadFactory.oliveCreateUserInfoPayload();
    const signature = crypto.oliveCreateSignature(payload, this.access_token);
    const config = {
      headers: {
        'Accept-Encoding': 'gzip',
        'User-Agent': 'myapp',
        appid: constants.oliveAppId,
        appinfo: constants.appInfo,
        phoneid: this.phoneId,
        access_token: this.access_token,
        signature2: signature,
      },
      params: payload,
    };
    try {
      const url = 'https://wyze-platform-service.wyzecam.com/app/v2/platform/get_user_profile';
      if (this.apiLogEnabled) this.log(`Performing request: ${url}`);
      const result = await axios.get(url, config);
      if (this.apiLogEnabled) {
        this.log(`API response GetUserProfile: ${JSON.stringify(result.data)}`);
      }

      return result.data;
    } catch (e) {
      const err = e as Error & { response?: AxiosResponse };
      this.log.error(`Request failed: ${err}`);

      if (err.response) {
        this.log.error(
          `Response GetUserProfile (${err.response.statusText}): ${JSON.stringify(err.response.data, null, '\t')}`,
        );
      }
      throw e;
    }
  }

  // ============================================================================
  // HMS (Home Monitoring System) Methods
  // ============================================================================

  async disableRemeAlarm(hmsId: string): Promise<unknown> {
    await this.maybeLogin();
    const config = {
      headers: {
        Authorization: this.access_token,
        'User-Agent': this.userAgent,
      },
      data: {
        hms_id: hmsId,
        remediation_id: 'emergency',
      },
    };
    try {
      const url = 'https://hms.api.wyze.com/api/v1/reme-alarm';
      if (this.apiLogEnabled) this.log(`Performing request: ${url}`);
      const result = await axios.delete(url, config);
      if (this.apiLogEnabled) {
        this.log(`API response DisableRemeAlarm: ${JSON.stringify(result.data)}`);
      }
      return result.data;
    } catch (e) {
      const err = e as Error & { response?: AxiosResponse };
      this.log.error(`Request failed: ${err}`);
      if (err.response && this.apiLogEnabled) {
        this.log.error(
          `Response DisableRemeAlarm (${err.response.statusText}): ${JSON.stringify(err.response.data, null, '\t')}`,
        );
      }
      throw e;
    }
  }

  async getPlanBindingListByUser(): Promise<unknown> {
    await this.maybeLogin();
    const payload = payloadFactory.oliveCreateHmsPayload();
    const signature = crypto.oliveCreateSignature(payload, this.access_token);
    const config = {
      headers: {
        'Accept-Encoding': 'gzip',
        'User-Agent': this.userAgent,
        appid: constants.oliveAppId,
        appinfo: constants.appInfo,
        phoneid: this.phoneId,
        access_token: this.access_token,
        signature2: signature,
      },
      params: payload,
    };

    try {
      const url = 'https://wyze-membership-service.wyzecam.com/platform/v2/membership/get_plan_binding_list_by_user';
      if (this.apiLogEnabled) this.log(`Performing request: ${url}`);
      const result = await axios.get(url, config);
      if (this.apiLogEnabled) {
        this.log(`API response GetPlanBindingListByUser: ${JSON.stringify(result.data)}`);
      }

      return result.data;
    } catch (e) {
      const err = e as Error & { response?: AxiosResponse };
      this.log.error(`Request failed: ${err}`);
      if (err.response) {
        this.log.error(
          `Response GetPlanBindingListByUser (${err.response.statusText}): ${JSON.stringify(err.response.data, null, '\t')}`,
        );
      }
      throw e;
    }
  }

  async monitoringProfileStateStatus(hmsId: string): Promise<unknown> {
    await this.maybeLogin();
    const query = payloadFactory.oliveCreateHmsGetPayload(hmsId);
    const signature = crypto.oliveCreateSignature(query, this.access_token);
    const config = {
      headers: {
        'User-Agent': this.userAgent,
        appid: constants.oliveAppId,
        appinfo: constants.appInfo,
        phoneid: this.phoneId,
        access_token: this.access_token,
        signature2: signature,
        Authorization: this.access_token,
        'Content-Type': 'application/json',
      },
      params: query,
    };

    try {
      const url = 'https://hms.api.wyze.com/api/v1/monitoring/v1/profile/state-status';
      if (this.apiLogEnabled) this.log(`Performing request: ${url}`);
      const result = await axios.get(url, config);
      if (this.apiLogEnabled) {
        this.log(`API response MonitoringProfileStateStatus: ${JSON.stringify(result.data)}`);
      }
      return result.data;
    } catch (e) {
      const err = e as Error & { response?: AxiosResponse };
      this.log.error(`Request failed: ${err}`);

      if (err.response) {
        this.log.error(
          `Response MonitoringProfileStateStatus (${err.response.statusText}): ${JSON.stringify(err.response.data, null, '\t')}`,
        );
      }
      throw e;
    }
  }

  async monitoringProfileActive(hmsId: string, home: number, away: number): Promise<unknown> {
    await this.maybeLogin();
    const payload = payloadFactory.oliveCreateHmsPatchPayload(hmsId);
    const signature = crypto.oliveCreateSignature(payload, this.access_token);

    const config = {
      headers: {
        'User-Agent': this.userAgent,
        appid: constants.oliveAppId,
        appinfo: constants.appInfo,
        phoneid: constants.phoneId,
        access_token: this.access_token,
        signature2: signature,
        Authorization: this.access_token,
      },
      params: payload,
    };

    const data = [
      {
        state: 'home',
        active: home,
      },
      {
        state: 'away',
        active: away,
      },
    ];

    try {
      const url = 'https://hms.api.wyze.com/api/v1/monitoring/v1/profile/active';
      if (this.apiLogEnabled) this.log(`Performing request: ${url}`);
      const result = await axios.patch(url, data, config);
      if (this.apiLogEnabled) {
        this.log(`API response MonitoringProfileActive: ${JSON.stringify(result.data)}`);
      }
      return result.data;
    } catch (e) {
      const err = e as Error & { response?: AxiosResponse };
      this.log.error(`Request failed: ${err}`);

      if (err.response) {
        this.log.error(
          `Response MonitoringProfileActive (${err.response.statusText}): ${JSON.stringify(err.response.data, null, '\t')}`,
        );
      }
      throw e;
    }
  }

  // ============================================================================
  // Thermostat Methods
  // ============================================================================

  async thermostatGetIotProp(deviceMac: string): Promise<unknown> {
    await this.maybeLogin();
    const keys = [
      'trigger_off_val,emheat,temperature,humidity,time2temp_val,protect_time,mode_sys,heat_sp,cool_sp',
      'current_scenario,config_scenario,temp_unit,fan_mode,iot_state,w_city_id,w_lat,w_lon,working_state',
      'dev_hold,dev_holdtime,asw_hold,app_version,setup_state,wiring_logic_id,save_comfort_balance',
      'kid_lock,calibrate_humidity,calibrate_temperature,fancirc_time,query_schedule',
    ].join(',');
    const payload = payloadFactory.oliveCreateGetPayload(deviceMac, keys);
    const signature = crypto.oliveCreateSignature(payload, this.access_token);
    const config = {
      headers: {
        'Accept-Encoding': 'gzip',
        'User-Agent': this.userAgent,
        appid: constants.oliveAppId,
        appinfo: constants.appInfo,
        phoneid: constants.phoneId,
        access_token: this.access_token,
        signature2: signature,
      },
      params: payload,
    };
    try {
      const url = 'https://wyze-earth-service.wyzecam.com/plugin/earth/get_iot_prop';
      if (this.apiLogEnabled) this.log(`Performing request: ${url}`);
      const result = await axios.get(url, config);
      if (this.apiLogEnabled) {
        this.log(`API response ThermostatGetIotProp: ${JSON.stringify(result.data)}`);
      }

      return result.data;
    } catch (e) {
      const err = e as Error & { response?: AxiosResponse };
      this.log.error(`Request failed: ${err}`);

      if (err.response) {
        this.log.error(
          `Response ThermostatGetIotProp (${err.response.statusText}): ${JSON.stringify(err.response.data, null, '\t')}`,
        );
      }
      throw e;
    }
  }

  async thermostatSetIotProp(
    deviceMac: string,
    deviceModel: string,
    propKey: string,
    value: unknown,
  ): Promise<unknown> {
    await this.maybeLogin();
    const payload = payloadFactory.oliveCreatePostPayload(deviceMac, deviceModel, propKey, value);
    const signature = crypto.oliveCreateSignatureSingle(JSON.stringify(payload), this.access_token);
    const config = {
      headers: {
        'Accept-Encoding': 'gzip',
        'Content-Type': 'application/json',
        'User-Agent': 'myapp',
        appid: constants.oliveAppId,
        appinfo: constants.appInfo,
        phoneid: this.phoneId,
        access_token: this.access_token,
        signature2: signature,
      },
    };

    try {
      const url = 'https://wyze-earth-service.wyzecam.com/plugin/earth/set_iot_prop_by_topic';
      const result = await axios.post(url, JSON.stringify(payload), config);
      if (this.apiLogEnabled) {
        this.log(`API response ThermostatSetIotProp: ${JSON.stringify(result.data)}`);
      }

      return result.data;
    } catch (e) {
      const err = e as Error & { response?: AxiosResponse };
      this.log.error(`Request failed: ${err}`);

      if (err.response) {
        this.log.error(
          `Response ThermostatSetIotProp (${err.response.statusText}): ${JSON.stringify(err.response.data, null, '\t')}`,
        );
      }
      throw e;
    }
  }

  // ============================================================================
  // Local Bulb Commands
  // ============================================================================

  /**
   * Sends a command to a local smart bulb device to set a specific property value.
   */
  async localBulbCommand(
    deviceMac: string,
    deviceModel: string,
    deviceEnr: string,
    deviceIp: string,
    propertyId: string,
    propertyValue: string | number,
    actionKey: string,
  ): Promise<void> {
    console.log(`Initiating local command for device ${deviceMac} (${deviceModel}).`);

    const plist: PropertyItem[] = [{ pid: propertyId, pvalue: String(propertyValue) }];

    const characteristics: LocalBulbCharacteristics = {
      mac: deviceMac.toUpperCase(),
      index: '1',
      ts: Date.now(),
      plist: plist,
    };

    const characteristicsStr = JSON.stringify(characteristics, null, 0);
    console.log(`Characteristics JSON: ${characteristicsStr}`);

    const characteristicsEnc = crypto.wyzeEncrypt(deviceEnr, characteristicsStr);
    console.log(`Encrypted characteristics: ${characteristicsEnc}`);

    const payload = {
      request: 'set_status',
      isSendQueue: 0,
      characteristics: characteristicsEnc,
    };

    const payloadStr = JSON.stringify(payload, null, 0).replace(/\\\\/g, '\\');
    console.log(`Payload JSON: ${payloadStr}`);

    const url = `http://${deviceIp}:88/device_request`;
    console.log(`Sending request to URL: ${url}`);

    try {
      const response = await axios.post(url, payloadStr, {
        headers: { 'Content-Type': 'application/json' },
      });

      console.log(`Response received from device ${deviceMac}:`, response.data);
    } catch (error) {
      const err = error as Error & { response?: AxiosResponse };
      if (err.response) {
        console.warn(
          `Failed to connect to bulb ${deviceMac}. HTTP status: ${err.response.status}. Response data:`,
          err.response.data,
        );

        console.log(`Attempting to fallback to cloud for device ${deviceMac}.`);
        await this.runActionList(deviceMac, deviceModel, propertyId, propertyValue, actionKey);
      } else {
        console.error(`Error occurred while sending command to device ${deviceMac}:`, error);
      }
    }
  }

  async authenticateAndFetchData(): Promise<void> {
    const rokuAuth = new RokuAuthLib(this.username, this.password);
    const token = await rokuAuth.getTokenWithUsernamePassword(this.username, this.password);

    console.log(token);
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  getUuid(deviceMac: string, deviceModel: string): string {
    return deviceMac.replace(`${deviceModel}.`, '');
  }

  async getObjectListSafe(): Promise<WyzeApiResponse<WyzeDeviceListResponse>> {
    try {
      return await this.getObjectList();
    } catch (error) {
      this.log.error(`Failed to get object list: ${(error as Error).message}`);
      throw error;
    }
  }

  async getDeviceList(): Promise<WyzeDevice[]> {
    const result = await this.getObjectListSafe();
    return result.data.device_list || [];
  }

  async getDeviceByName(nickname: string): Promise<WyzeDevice | undefined> {
    const devices = await this.getDeviceList();
    return devices.find((device) => device.nickname.toLowerCase() === nickname.toLowerCase());
  }

  async getDeviceByMac(mac: string): Promise<WyzeDevice | undefined> {
    const devices = await this.getDeviceList();
    return devices.find((device) => device.mac === mac);
  }

  async getDevicesByType(type: string): Promise<WyzeDevice[]> {
    const devices = await this.getDeviceList();
    return devices.filter((device) => device.product_type.toLowerCase() === type.toLowerCase());
  }

  async getDevicesByModel(model: string): Promise<WyzeDevice[]> {
    const devices = await this.getDeviceList();
    return devices.filter((device) => device.product_model.toLowerCase() === model.toLowerCase());
  }

  async getDeviceGroupsList(): Promise<unknown[]> {
    const result = await this.getObjectListSafe();
    return (result.data as unknown as { device_group_list?: unknown[] }).device_group_list ?? [];
  }

  async getDeviceSortList(): Promise<unknown[]> {
    const result = await this.getObjectListSafe();
    return (result.data as unknown as { device_sort_list?: unknown[] }).device_sort_list ?? [];
  }

  getDeviceStatus(device: WyzeDevice): Record<string, unknown> | undefined {
    return device.device_params;
  }

  async getDevicePID(deviceMac: string, deviceModel: string): Promise<WyzeApiResponse<WyzePropertyListResponse>> {
    return await this.getPropertyList(deviceMac, deviceModel);
  }

  // ============================================================================
  // Camera Methods
  // ============================================================================

  async cameraPrivacy(deviceMac: string, deviceModel: string, value: string): Promise<void> {
    await this.runAction(deviceMac, deviceModel, value);
  }

  async cameraTurnOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.runAction(deviceMac, deviceModel, 'power_on');
  }

  async cameraTurnOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.runAction(deviceMac, deviceModel, 'power_off');
  }

  async garageDoor(deviceMac: string, deviceModel: string): Promise<void> {
    await this.runAction(deviceMac, deviceModel, 'garage_door_trigger');
  }

  async cameraSiren(deviceMac: string, deviceModel: string, value: string): Promise<void> {
    await this.runAction(deviceMac, deviceModel, value);
  }

  async cameraSirenOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.runAction(deviceMac, deviceModel, 'siren_on');
  }

  async cameraSirenOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.runAction(deviceMac, deviceModel, 'siren_off');
  }

  async turnMeshOn(deviceMac: string, deviceModel: string): Promise<WyzeApiResponse> {
    return await this.runActionList(deviceMac, deviceModel, 'P3', '1', 'set_mesh_property');
  }

  async turnMeshOff(deviceMac: string, deviceModel: string): Promise<WyzeApiResponse> {
    return await this.runActionList(deviceMac, deviceModel, 'P3', '0', 'set_mesh_property');
  }

  // ============================================================================
  // Lock Methods
  // ============================================================================

  async unlockLock(device: WyzeDevice): Promise<unknown> {
    return await this.controlLock(device.mac, device.product_model, 'remoteUnlock');
  }

  async lockLock(device: WyzeDevice): Promise<unknown> {
    return await this.controlLock(device.mac, device.product_model, 'remoteLock');
  }

  async lockInfo(device: WyzeDevice): Promise<unknown> {
    return await this.getLockInfo(device.mac, device.product_model);
  }

  // ============================================================================
  // Camera Light Methods
  // ============================================================================

  async cameraFloodLight(deviceMac: string, deviceModel: string, value: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1056', value);
  }

  async cameraFloodLightOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1056', '1');
  }

  async cameraFloodLightOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1056', '2');
  }

  async cameraSpotLight(deviceMac: string, deviceModel: string, value: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1056', value);
  }

  async cameraSpotLightOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1056', '1');
  }

  async cameraSpotLightOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1056', '2');
  }

  // ============================================================================
  // Camera Motion/Notification Methods
  // ============================================================================

  async cameraMotionOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1001', 1);
  }

  async cameraMotionOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1001', 0);
  }

  async cameraSoundNotificationOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1048', '1');
  }

  async cameraSoundNotificationOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1048', '0');
  }

  async cameraNotifications(deviceMac: string, deviceModel: string, value: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1', value);
  }

  async cameraNotificationsOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1', '1');
  }

  async cameraNotificationsOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1', '0');
  }

  async cameraMotionRecording(deviceMac: string, deviceModel: string, value: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1047', value);
  }

  async cameraMotionRecordingOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1047', '1');
  }

  async cameraMotionRecordingOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1047', '0');
  }

  // ============================================================================
  // Plug Methods
  // ============================================================================

  async plugPower(deviceMac: string, deviceModel: string, value: string | number): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P3', value);
  }

  async plugTurnOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P3', '1');
  }

  async plugTurnOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P3', '0');
  }

  // ============================================================================
  // Light Methods
  // ============================================================================

  async lightPower(deviceMac: string, deviceModel: string, value: string | number): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P3', value);
  }

  async lightTurnOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P3', '1');
  }

  async lightTurnOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P3', '0');
  }

  async setBrightness(deviceMac: string, deviceModel: string, value: string | number): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1501', value);
  }

  async setColorTemperature(deviceMac: string, deviceModel: string, value: string | number): Promise<void> {
    await this.setProperty(deviceMac, deviceModel, 'P1502', value);
  }

  // ============================================================================
  // Mesh Light Methods
  // ============================================================================

  async lightMeshPower(deviceMac: string, deviceModel: string, value: string | number): Promise<void> {
    await this.runActionList(deviceMac, deviceModel, 'P3', value, 'set_mesh_property');
  }

  async lightMeshOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.runActionList(deviceMac, deviceModel, 'P3', '1', 'set_mesh_property');
  }

  async lightMeshOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.runActionList(deviceMac, deviceModel, 'P3', '0', 'set_mesh_property');
  }

  async setMeshBrightness(deviceMac: string, deviceModel: string, value: number): Promise<void> {
    await this.runActionList(deviceMac, deviceModel, 'P1501', value, 'set_mesh_property');
  }

  async setMeshColorTemperature(deviceMac: string, deviceModel: string, value: number): Promise<void> {
    await this.runActionList(deviceMac, deviceModel, 'P1502', value, 'set_mesh_property');
  }

  async setMeshHue(deviceMac: string, deviceModel: string, value: number): Promise<void> {
    await this.runActionList(deviceMac, deviceModel, 'P1507', value, 'set_mesh_property');
  }

  async setMeshSaturation(deviceMac: string, deviceModel: string, value: number): Promise<void> {
    await this.runActionList(deviceMac, deviceModel, 'P1507', value, 'set_mesh_property');
  }

  // ============================================================================
  // Wall Switch Methods
  // ============================================================================

  async wallSwitchPower(deviceMac: string, deviceModel: string, value: boolean): Promise<void> {
    await this.setIotProp(deviceMac, deviceModel, 'switch-power', value);
  }

  async wallSwitchPowerOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setIotProp(deviceMac, deviceModel, 'switch-power', true);
  }

  async wallSwitchPowerOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setIotProp(deviceMac, deviceModel, 'switch-power', false);
  }

  async wallSwitchIot(deviceMac: string, deviceModel: string, value: boolean): Promise<void> {
    await this.setIotProp(deviceMac, deviceModel, 'switch-iot', value);
  }

  async wallSwitchIotOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setIotProp(deviceMac, deviceModel, 'switch-iot', true);
  }

  async wallSwitchIotOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setIotProp(deviceMac, deviceModel, 'switch-iot', false);
  }

  async wallSwitchLedStateOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setIotProp(deviceMac, deviceModel, 'led_state', true);
  }

  async wallSwitchLedStateOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setIotProp(deviceMac, deviceModel, 'led_state', false);
  }

  async wallSwitchVacationModeOn(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setIotProp(deviceMac, deviceModel, 'vacation_mode', 0);
  }

  async wallSwitchVacationModeOff(deviceMac: string, deviceModel: string): Promise<void> {
    await this.setIotProp(deviceMac, deviceModel, 'vacation_mode', 1);
  }

  // ============================================================================
  // HMS State Methods
  // ============================================================================

  async getHmsID(): Promise<void> {
    await this.getPlanBindingListByUser();
  }

  async setHMSState(hmsId: string, mode: 'off' | 'away' | 'home'): Promise<void> {
    if (mode === 'off') {
      await this.disableRemeAlarm(hmsId);
      await this.monitoringProfileActive(hmsId, 0, 0);
    } else if (mode === 'away') {
      await this.monitoringProfileActive(hmsId, 0, 1);
    } else if (mode === 'home') {
      await this.monitoringProfileActive(hmsId, 1, 0);
    }
  }

  async getHmsUpdate(hmsId: string): Promise<unknown> {
    return await this.monitoringProfileStateStatus(hmsId);
  }

  // ============================================================================
  // Device State Methods
  // ============================================================================

  getDeviceState(device: WyzeDevice): string {
    const params = device.device_params as { power_switch?: number; open_close_state?: number } | undefined;
    let state = params?.power_switch !== undefined ? (params.power_switch === 1 ? 'on' : 'off') : '';
    if (!state) {
      state = params?.open_close_state !== undefined ? (params.open_close_state === 1 ? 'open' : 'closed') : '';
    }
    return state;
  }

  async getDeviceStatePID(deviceMac: string, deviceModel: string, pid: string): Promise<number | string | undefined> {
    const prop = await this.getDevicePID(deviceMac, deviceModel);
    for (const property of prop.data.property_list) {
      if (pid === property.pid) {
        return (property as { pid: string; pvalue: string; value?: string }).value !== undefined
          ? (property as { pid: string; pvalue: string; value?: string }).value === '1'
              ? 1
              : 0
          : '';
      }
    }
    return undefined;
  }

  getLockDoorState(deviceState: number): number {
    if (deviceState >= 2) {
      return 1;
    } else {
      return deviceState;
    }
  }

  getLeakSensorState(deviceState: number): number {
    if (deviceState >= 2) {
      return 1;
    } else {
      return deviceState;
    }
  }

  getLockState(deviceState: number): number {
    if (deviceState === 2) {
      return 0;
    } else {
      return 1;
    }
  }

  checkBatteryVoltage(value: number | undefined | null): number {
    if (value === undefined || value === null) {
      return 1;
    } else if (value >= 100) {
      return 100;
    } else {
      return value;
    }
  }

  checkLowBattery(batteryVolts: number): number {
    if (this.checkBatteryVoltage(batteryVolts) <= this.lowBatteryPercentage) {
      return 1;
    } else {
      return 0;
    }
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  rangeToFloat(value: number, min: number, max: number): number {
    return (value - min) / (max - min);
  }

  floatToRange(value: number, min: number, max: number): number {
    return Math.round(value * (max - min) + min);
  }

  kelvinToMired(value: number): number {
    return Math.round(1000000 / value);
  }

  checkBrightnessValue(value: number): number {
    if (value >= 1 && value <= 100) {
      return value;
    } else {
      return value;
    }
  }

  checkColorTemp(color: number): number {
    if (color >= 500) {
      return color;
    } else {
      return 500;
    }
  }

  fahrenheit2celsius(fahrenheit: number): number {
    return (fahrenheit - 32.0) / 1.8;
  }

  celsius2fahrenheit(celsius: number): number {
    return celsius * 1.8 + 32.0;
  }

  clamp(number: number, min: number, max: number): number {
    return Math.max(min, Math.min(number, max));
  }

  sleepSeconds(seconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  sleepMilliSeconds(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default WyzeAPI;
