# Export client helper (JS)

This is a small JavaScript helper for calling the AWS Export API.

It:
- computes the **HMAC request signature**
- presigns S3 uploads via `POST /export/presign`
- uploads assets directly to S3 with PUT
- starts the export job via `POST /export`
- polls via `GET /export/{jobId}` until done

## Intended usage

Use this from:
- your Base44 server/backend, OR
- a dev script on your machine

Avoid shipping the signing secret to untrusted browsers.

## Example

```js
import fs from 'node:fs/promises';
import { exportVideo } from './exportClient.js';

const baseUrl = process.env.EXPORT_API_BASE_URL;
const secret = process.env.EXPORT_SIGNING_SECRET;

const timeline = { editorData: [] };

const fileBytes = await fs.readFile('./my-video.mp4');

const result = await exportVideo({
  baseUrl,
  secret,
  timeline,
  assets: [
    {
      src: 'file:///my-video.mp4',
      body: fileBytes,
      contentType: 'video/mp4',
      ext: '.mp4',
    },
  ],
});

console.log(result);
```
