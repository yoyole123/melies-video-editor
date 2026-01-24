/**
 * Manual verification script for the IAM-protected Export API.
 * 
 * Usage:
 * 1. Deploy the stack: `cdk deploy --outputs-file output.json`
 * 2. Run this script with options from the output file:
 *    export API_URL="https://..."
 *    export REGION="il-central-1"
 *    export IDENTITY_POOL_ID="..."
 *    node scripts/test-manual.js
 */

const { createExportIamClient } = require('../client/iamExportClient.js');

const API_URL = process.env.API_URL;
const REGION = process.env.REGION;
const IDENTITY_POOL_ID = process.env.IDENTITY_POOL_ID;

if (!API_URL || !REGION || !IDENTITY_POOL_ID) {
  console.error('Error: Missing environment variables.');
  console.error('Usage: set API_URL=... && set REGION=... && set IDENTITY_POOL_ID=... &&YX node scripts/test-manual.js');
  process.exit(1);
}

const client = createExportIamClient({
  apiBaseUrl: API_URL,
  region: REGION,
  identityPoolId: IDENTITY_POOL_ID,
});

async function run() {
  try {
    console.log('--- Testing /health ---');
    const health = await client.health();
    console.log('Health:', health);

    console.log('\n--- Testing /export/presign ---');
    const presign = await client.presignAssets([
      { src: 'file://./test1.mp4', ext: '.mp4', contentType: 'video/mp4' }
    ]);
    console.log(`Received ${presign.uploads.length} upload URLs.`);
    console.log('First upload URL:', presign.uploads[0].uploadUrl.substring(0, 50) + '...');

    console.log('\n--- Testing /export (Job Creation) ---');
    // Minimal mock timeline
    const timeline = { 
        version: 1, 
        editorData: [] 
    };
    const job = await client.startExport({
      timeline,
      assets: presign.uploads // pass back the s3Keys we just got
    });
    console.log('Job Started:', job);

    console.log('\n--- Testing /export/:jobId (Status Check) ---');
    const status = await client.getJob(job.jobId);
    console.log('Job Status:', status);

    console.log('\n✅ detailed verification complete.');

  } catch (err) {
    console.error('\n❌ Test Failed:', err.message);
    if (err.cause) console.error(err.cause);
    process.exit(1);
  }
}

run();