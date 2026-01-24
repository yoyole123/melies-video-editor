/**
 * Browser/client helper for calling the IAM-protected Export API.
 *
 * Auth model:
 * - Uses a Cognito Identity Pool (unauthenticated) to obtain short-lived AWS creds.
 * - Uses SigV4 (execute-api) to call API Gateway HTTP API.
 *
 * This file is intended to be bundled into a browser app (e.g. Base44).
 */

/**
 * @typedef {Object} AwsCredentials
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} sessionToken
 * @property {number} expirationMs Unix epoch millis
 */

/**
 * @typedef {Object} ExportIamClientConfig
 * @property {string} apiBaseUrl Base URL from CDK output `ExportApiBaseUrl` (includes stage, e.g. https://.../prod)
 * @property {string} region AWS region from CDK output `ExportRegion`
 * @property {string} identityPoolId Cognito Identity Pool id from CDK output `ExportIdentityPoolId`
 */

const DEFAULT_CREDENTIAL_REFRESH_SKEW_MS = 60_000;

/**
 * Calls the Cognito Identity JSON-RPC endpoint.
 *
 * NOTE: These operations are used by browsers to get unauth credentials for an Identity Pool.
 * The Identity Pool must have `AllowUnauthenticatedIdentities: true`.
 *
 * @param {object} params
 * @param {string} params.region
 * @param {string} params.action Cognito Identity action name (e.g. "GetId")
 * @param {object} params.body
 */
async function cognitoIdentityRpc({ region, action, body }) {
  const url = `https://cognito-identity.${region}.amazonaws.com/`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityService.${action}`,
    },
    body: JSON.stringify(body ?? {}),
  });

  const text = await resp.text();
  const payload = text ? JSON.parse(text) : {};

  if (!resp.ok) {
    const message = payload?.message || payload?.Message || `Cognito Identity ${action} failed (${resp.status}).`;
    throw new Error(String(message));
  }

  return payload;
}

/**
 * Obtains short-lived AWS credentials from an unauthenticated Cognito Identity Pool.
 *
 * @param {object} params
 * @param {string} params.region
 * @param {string} params.identityPoolId
 * @returns {Promise<AwsCredentials>}
 */
async function getUnauthCredentials({ region, identityPoolId }) {
  const idResp = await cognitoIdentityRpc({
    region,
    action: 'GetId',
    body: { IdentityPoolId: identityPoolId },
  });

  const identityId = String(idResp?.IdentityId ?? '');
  if (!identityId) throw new Error('Failed to obtain Cognito IdentityId.');

  const credsResp = await cognitoIdentityRpc({
    region,
    action: 'GetCredentialsForIdentity',
    body: { IdentityId: identityId },
  });

  const c = credsResp?.Credentials ?? {};
  const accessKeyId = String(c?.AccessKeyId ?? '');
  const secretAccessKey = String(c?.SecretKey ?? '');
  const sessionToken = String(c?.SessionToken ?? '');

  // Expiration is usually an ISO string, but be defensive.
  const expirationRaw = c?.Expiration;
  const expirationMs =
    typeof expirationRaw === 'number'
      ? expirationRaw * 1000
      : typeof expirationRaw === 'string'
        ? Date.parse(expirationRaw)
        : 0;

  if (!accessKeyId || !secretAccessKey || !sessionToken || !Number.isFinite(expirationMs) || expirationMs <= 0) {
    throw new Error('Failed to obtain Cognito credentials.');
  }

  return { accessKeyId, secretAccessKey, sessionToken, expirationMs };
}

/**
 * Creates a function that returns cached AWS credentials, refreshing shortly before expiration.
 *
 * @param {object} params
 * @param {string} params.region
 * @param {string} params.identityPoolId
 */
function createCredentialProvider({ region, identityPoolId }) {
  /** @type {AwsCredentials | null} */
  let cached = null;

  return async function getCreds() {
    const now = Date.now();

    if (cached && cached.expirationMs - now > DEFAULT_CREDENTIAL_REFRESH_SKEW_MS) {
      return cached;
    }

    cached = await getUnauthCredentials({ region, identityPoolId });
    return cached;
  };
}

/**
 * Loads AwsClient from `aws4fetch`.
 *
 * Kept behind a function so this file can be used in environments that prefer
 * CDN imports or different bundlers.
 */
async function loadAws4FetchClientCtor() {
  // eslint-disable-next-line no-undef
  const mod = await import('aws4fetch');
  if (!mod?.AwsClient) throw new Error('Missing aws4fetch.AwsClient export.');
  return mod.AwsClient;
}

/**
 * Creates a minimal, Base44-friendly client for the Export API.
 *
 * Usage:
 * - `pnpm add aws4fetch` (or `npm i aws4fetch`) in your frontend project.
 * - Wire in CDK outputs: `ExportApiBaseUrl`, `ExportRegion`, `ExportIdentityPoolId`.
 *
 * @param {ExportIamClientConfig} config
 */
export function createExportIamClient(config) {
  const apiBaseUrl = String(config?.apiBaseUrl ?? '').replace(/\/+$/, '');
  const region = String(config?.region ?? '');
  const identityPoolId = String(config?.identityPoolId ?? '');

  if (!apiBaseUrl) throw new Error('Missing apiBaseUrl.');
  if (!region) throw new Error('Missing region.');
  if (!identityPoolId) throw new Error('Missing identityPoolId.');

  const getCreds = createCredentialProvider({ region, identityPoolId });

  /**
   * Performs a SigV4-signed request to API Gateway and parses JSON.
   *
   * @param {object} params
   * @param {string} params.path Path beginning with '/'
   * @param {string} params.method
   * @param {unknown} [params.body]
   */
  async function signedJson({ path, method, body }) {
    // Treat path as relative to preserve the stage in apiBaseUrl if present
    const safeBase = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
    const relativePath = path.startsWith('/') ? path.slice(1) : path;
    const url = new URL(relativePath, safeBase);

    console.log(`[Client] Requesting: ${method} ${url.toString()}`);

    const credentials = await getCreds();
    const AwsClient = await loadAws4FetchClientCtor();

    const aws = new AwsClient({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      region,
      service: 'execute-api',
    });

    const hasBody = body !== undefined;
    const bodyString = hasBody ? JSON.stringify(body) : undefined;

    const resp = await aws.fetch(url.toString(), {
      method,
      headers: hasBody
        ? {
            'content-type': 'application/json',
          }
        : undefined,
      body: bodyString,
    });

    const contentType = resp.headers.get('content-type') || '';
    const isJson = contentType.toLowerCase().includes('application/json');
    const parsed = isJson ? await resp.json() : await resp.text();

    if (!resp.ok) {
      const msg = typeof parsed === 'object' && parsed && parsed.error ? parsed.error : JSON.stringify(parsed);
      throw new Error(`Export API request failed (${resp.status}): ${msg}`);
    }

    return parsed;
  }

  return {
    /**
     * Calls `GET /health`.
     */
    health: () => signedJson({ path: '/health', method: 'GET' }),

    /**
     * Calls `POST /export/presign`.
     *
     * @param {Array<{src: string, contentType?: string, ext?: string}>} assets
     */
    presignAssets: (assets) => signedJson({ path: '/export/presign', method: 'POST', body: { assets } }),

    /**
     * Calls `POST /export`.
     *
     * @param {object} params
     * @param {unknown} params.timeline
     * @param {Array<{src: string, s3Key: string}>} params.assets
     */
    startExport: ({ timeline, assets }) => signedJson({ path: '/export', method: 'POST', body: { timeline, assets } }),

    /**
     * Calls `GET /export/{jobId}`.
     *
     * @param {string} jobId
     */
    getJob: (jobId) => signedJson({ path: `/export/${encodeURIComponent(jobId)}`, method: 'GET' }),
  };
}
