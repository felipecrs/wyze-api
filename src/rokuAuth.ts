import axios from 'axios';
import AWS from 'aws-sdk';
import crypto from 'crypto';
import querystring from 'querystring';

// ============================================================================
// Types
// ============================================================================

export interface RokuToken {
  accessToken: string;
  refreshToken: string;
}

export interface RokuLoginResponse {
  message?: string;
  data?: {
    partnerAccess: {
      token: string;
    };
    oauth: {
      refreshToken: string;
    };
  };
}

export type RokuTokenCallback = (token: RokuToken) => Promise<void> | void;

interface AWSCredentials {
  AccessKeyId: string;
  SecretKey: string;
  SessionToken?: string;
  Expiration?: Date;
}

interface SignedRequest {
  headers: Record<string, string>;
}

// ============================================================================
// RokuAuthLib Class
// ============================================================================

export class RokuAuthLib {
  private username: string | null;
  private password: string | null;
  private token: RokuToken | null;
  private tokenCallback: RokuTokenCallback | null;
  private cognitoId: string | undefined;

  // App configuration
  private readonly phoneSystemType = 2;
  private readonly appName = 'com.roku.rokuhome';
  private readonly appVersion = '3.0.2';
  private readonly appVer = 'com.roku.rokuhome___3.0.2';
  private readonly appInfo = 'Owl_android/3.0.2';

  // AWS configuration
  private readonly awsRegion = 'us-east-1';
  private readonly awsIdPool: string;
  private readonly loginHost = 'iot.prod.mobile.roku.com';
  private readonly loginUri: string;

  private readonly cognitoClient: AWS.CognitoIdentity;

  constructor(
    username: string | null = null,
    password: string | null = null,
    token: RokuToken | null = null,
    tokenCallback: RokuTokenCallback | null = null,
  ) {
    this.username = username;
    this.password = password;
    this.token = token;
    this.tokenCallback = tokenCallback;

    this.awsIdPool = `${this.awsRegion}:11747937-25e8-402f-8e72-6873a618692c`;
    this.loginUri = `https://${this.loginHost}/user/login`;

    this.cognitoClient = new AWS.CognitoIdentity({ region: this.awsRegion });
  }

  /**
   * Initialize Cognito Identity ID
   */
  async initializeCognitoId(): Promise<void> {
    try {
      const data = await this.cognitoClient.getId({ IdentityPoolId: this.awsIdPool }).promise();
      this.cognitoId = data.IdentityId;
    } catch (err) {
      console.error('Error retrieving IdentityId:', err);
      throw err;
    }
  }

  /**
   * Get token using username and password
   */
  async getTokenWithUsernamePassword(username: string, password: string): Promise<RokuToken> {
    if (!this.cognitoId) {
      await this.initializeCognitoId();
    }

    this.username = username;
    this.password = password;

    const loginPayload = JSON.stringify({
      email: this.username,
      password: this.password,
    });

    const credentials = await this.getAWSCredentials();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'Owl/0 CFNetwork/1496.0.7 Darwin/23.5.0',
      'Content-Type': 'application/json; charset=UTF-8',
      Host: this.loginHost,
      'apiweb-env': 'prod',
      app: 'harold',
      client_id: '62D8CC2A-F64E-46FC-9A18-F0C6F90E9A43_Owl',
      appversion: '3.0.2',
      'assertion-challenge': '6bfd613a96324175a90970349a5150d4',
      Connection: 'keep-alive',
      'assertion-request-ts': Date.now().toString(),
      osversion: '17.5.1',
      'profile-id-is-uuid': 'true',
      version: '2.0',
      'x-roku-reserved-client-id': 'x-roku-reserved-client-id',
      'x-roku-reserved-correlation': ' mob_3E1E8CAE-7AAC-494D-B33C-05E44B3B09EB',
      'x-roku-reserved-culture-code': 'en_US',
      'x-roku-reserved-dev-id': '1a2f5fd09622fd2b68be13fff92f09aebb6837fd',
      'x-roku-reserved-lat': 'true',
      'x-roku-reserved-locale': 'en_US',
      'x-roku-reserved-mobile-experiment-ids': '',
      'x-roku-reserved-profile-id': '6CD68D77-B0FC-488C-83CD-D141191568E4',
      'x-roku-reserved-request-id': '15703A04-15B7-4F95-B838-BCBDC8D0E3BB',
      'x-roku-reserved-rida': '',
      'x-roku-reserved-session-id': 'D90F5E79-E28E-4439-8909-2B96A47DE82F',
      'x-roku-reserved-time-zone-offset': '-05:00',
    };

    const signedRequest = this.signRequest('POST', this.loginUri, headers, loginPayload, credentials);

    try {
      const response = await axios.post<RokuLoginResponse>(this.loginUri, loginPayload, {
        headers: signedRequest.headers,
      });

      if (response.data.message) {
        console.error(`Unable to login with response from Roku: ${JSON.stringify(response.data)}`);
        throw new Error('UnknownApiError');
      }

      if (!response.data.data) {
        throw new Error('Invalid response from Roku API');
      }

      this.token = {
        accessToken: response.data.data.partnerAccess.token,
        refreshToken: response.data.data.oauth.refreshToken,
      };

      if (this.tokenCallback) {
        await this.tokenCallback(this.token);
      }

      return this.token;
    } catch (error) {
      console.error('Error during login:', error);
      throw error;
    }
  }

  /**
   * Get AWS credentials from Cognito
   */
  async getAWSCredentials(): Promise<AWSCredentials> {
    try {
      const data = await this.cognitoClient.getCredentialsForIdentity({ IdentityId: this.cognitoId! }).promise();

      if (!data.Credentials) {
        throw new Error('No credentials returned from Cognito');
      }

      return {
        AccessKeyId: data.Credentials.AccessKeyId!,
        SecretKey: data.Credentials.SecretKey!,
        SessionToken: data.Credentials.SessionToken,
        Expiration: data.Credentials.Expiration,
      };
    } catch (err) {
      console.error('Error retrieving AWS credentials:', err);
      throw err;
    }
  }

  /**
   * Sign a request using AWS Signature Version 4
   */
  signRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string,
    credentials: AWSCredentials,
  ): SignedRequest {
    const parsedUrl = new URL(url);
    const canonicalUri = parsedUrl.pathname;
    const canonicalQuerystring = querystring.stringify(Object.fromEntries(parsedUrl.searchParams));

    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((key) => `${key.toLowerCase()}:${headers[key].trim()}\n`)
      .join('');

    const signedHeaders = Object.keys(headers)
      .map((key) => key.toLowerCase())
      .sort()
      .join(';');

    const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    const dateStamp = new Date().toISOString().split('T')[0];
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');

    const credentialScope = `${dateStamp}/${this.awsRegion}/execute-api/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;

    const signingKey = this.getSignatureKey(credentials.SecretKey, dateStamp, this.awsRegion, 'execute-api');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${credentials.AccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return { headers };
  }

  /**
   * Generate AWS signing key
   */
  getSignatureKey(key: string, dateStamp: string, regionName: string, serviceName: string): Buffer {
    const kDate = crypto.createHmac('sha256', `AWS4${key}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(regionName).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(serviceName).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    return kSigning;
  }
}

export default RokuAuthLib;
