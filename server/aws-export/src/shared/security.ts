import crypto from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsClient = new SecretsManagerClient({});

let cachedSecretPromise: Promise<string> | null = null;

/**
 * Loads the HMAC signing secret from Secrets Manager.
 *
 * Cached per Lambda execution environment to reduce latency.
 */
export async function getSigningSecret(signingSecretArn: string): Promise<string> {
  if (!cachedSecretPromise) {
    cachedSecretPromise = (async () => {
      const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: signingSecretArn }));
      const secretString = resp.SecretString ?? '';
      if (!secretString) throw new Error('Signing secret is empty.');
      return secretString;
    })();
  }
  return cachedSecretPromise;
}

/**
 * Computes an HMAC-SHA256 signature for the given message.
 */
export function computeSignatureHex(secret: string, message: string): string {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Constant-time comparison for hex strings.
 */
export function safeEqualHex(a: string, b: string): boolean {
  const aa = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  if (aa.length === 0 || bb.length === 0) return false;
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

/**
 * Validates an incoming request signature.
 */
export async function assertValidSignature(params: {
  signingSecretArn: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  method: string;
  path: string;
  rawBody: string;
  maxSkewSeconds: number;
}): Promise<void> {
  const {
    signingSecretArn,
    timestampHeader,
    signatureHeader,
    method,
    path,
    rawBody,
    maxSkewSeconds,
  } = params;

  if (!timestampHeader || !signatureHeader) {
    throw new Error('Missing request signature headers.');
  }

  const timestampMs = Number(timestampHeader);
  if (!Number.isFinite(timestampMs)) {
    throw new Error('Invalid x-base44-timestamp.');
  }

  const nowMs = Date.now();
  const skewSeconds = Math.abs(nowMs - timestampMs) / 1000;
  if (skewSeconds > maxSkewSeconds) {
    throw new Error('Request timestamp is outside the allowed window.');
  }

  const secret = await getSigningSecret(signingSecretArn);
  const message = `${timestampMs}.${method.toUpperCase()}.${path}.${rawBody}`;
  const expected = computeSignatureHex(secret, message);

  if (!safeEqualHex(expected, signatureHeader)) {
    throw new Error('Invalid request signature.');
  }
}
