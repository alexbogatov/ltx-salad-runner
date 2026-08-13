import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const filename = process.argv[2] || 'test_status.txt';
const custom_message = process.argv[3] || 'Ping from entrypoint script';

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  console.error(`[R2 Step Check] Missing R2 environment variables. Skipping upload for: ${filename}`);
  process.exit(0); // Exit cleanly so entrypoint script isn't blocked
}

const s3_client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

async function send_checkpoint() {
  const content = [
    `[CHECKPOINT LOG] ${filename}`,
    `Timestamp: ${new Date().toISOString()}`,
    `Message: ${custom_message}`,
    `Salad Machine ID: ${process.env.salad_machine_id || 'unknown_node'}`
  ].join('\n');

  try {
    await s3_client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: filename,
      Body: content,
      ContentType: 'text/plain',
    }));
    console.log(`[R2 Checkpoint SUCCESS] Uploaded: ${filename}`);
  } catch (err) {
    console.error(`[R2 Checkpoint ERROR] Failed to upload ${filename}:`, err.message);
  }
}

send_checkpoint();
