# Export client helper (JS)

This is a small JavaScript helper for calling the AWS Export API.

It:
- presigns S3 uploads via `POST /export/presign`
- uploads assets directly to S3 with PUT
- starts the export job via `POST /export`
- polls via `GET /export/{jobId}` until done

## Intended usage

The Export API is protected by **IAM (SigV4)**. For browser usage, use a Cognito **Identity Pool** (unauthenticated) to obtain short-lived credentials, then SigV4-sign requests to API Gateway.

This folder contains:
- `iamExportClient.js` (current) — browser-friendly IAM/SigV4 helper
- `exportClient.js` (deprecated) — the old HMAC-based helper (kept only for historical reference)

`iamExportClient.js` uses `aws4fetch` for SigV4 signing.

## Example

Install the signer dependency in your frontend project:

- `pnpm add aws4fetch` (or `npm i aws4fetch`)

Then:

```js
import { createExportIamClient } from './iamExportClient.js';

const exportApi = createExportIamClient({
	apiBaseUrl: '<ExportApiBaseUrl>',
	region: '<ExportRegion>',
	identityPoolId: '<ExportIdentityPoolId>',
});

await exportApi.health();
```

See the main README for the required CDK outputs (`ExportApiBaseUrl`, `ExportIdentityPoolId`, `ExportRegion`).
