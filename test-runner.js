import { spawn } from 'child_process';
import { readFileSync, readdirSync, createReadStream } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// --- Configuration ---
const COMFY_PORT = 8188;
const COMFY_HOST = `http://127.0.0.1:${COMFY_PORT}`;
const API_JSON_PATH = join(process.cwd(), 'video_ltx2_5_i2v.json');
const INPUT_DIR = join(process.cwd(), 'ComfyUI', 'input');
const OUTPUT_DIR = join(process.cwd(), 'ComfyUI', 'output');
const TEST_IMAGE_PATH = join(INPUT_DIR, 'test_input.jpg');
const DEFAULT_TEST_IMAGE_URL = 'https://picsum.photos/1024/576.jpg';

// --- R2 Credentials ---
const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || '',
    secretAccessKey: R2_SECRET_ACCESS_KEY || '',
  },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: Target and override Node inputs
function setNodeInputs(workflow, targetType, targetTitle, newInputs) {
  let count = 0;
  for (const [nodeId, node] of Object.entries(workflow)) {
    const matchesType = targetType ? node.class_type === targetType : true;
    const matchesTitle = targetTitle ? node._meta?.title === targetTitle : true;

    if (matchesType && matchesTitle) {
      node.inputs = { ...node.inputs, ...newInputs };
      console.log(`[Config] Updated Node ID "${nodeId}" (${node.class_type}):`, newInputs);
      count++;
    }
  }
  if (count === 0) {
    console.warn(`[Config Warning] No nodes matched Type: "${targetType}" / Title: "${targetTitle}"`);
  }
}

// 1. Download Test Image
async function downloadTestImage(url) {
  console.log(`[Setup] Downloading test image from ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);
  const buffer = await res.arrayBuffer();
  await mkdir(INPUT_DIR, { recursive: true });
  await writeFile(TEST_IMAGE_PATH, Buffer.from(buffer));
  console.log(`[Setup] Image saved to ${TEST_IMAGE_PATH}`);
}

// 2. Launch Local ComfyUI Instance
function launchComfyUI() {
  console.log('[ComfyUI] Launching headless process...');
  const comfyProcess = spawn('python3', ['main.py', '--port', String(COMFY_PORT), '--dont-print-server'], {
    cwd: join(process.cwd(), 'ComfyUI'),
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  comfyProcess.on('error', (err) => {
    console.error('[ComfyUI] Process error:', err);
    process.exit(1);
  });

  return comfyProcess;
}

// 3. Poll Server Status
async function waitForComfyReady() {
  console.log('[ComfyUI] Waiting for API endpoint...');
  const healthUrl = `${COMFY_HOST}/history`;
  while (true) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        console.log('[ComfyUI] Server online.');
        break;
      }
    } catch (_) {
      // Waiting for server spin up
    }
    await sleep(2000);
  }
}

// 4. Submit & Benchmark Execution
async function executeWorkflow(payload) {
  console.log('[Workflow] Submitting JSON prompt payload...');
  const response = await fetch(`${COMFY_HOST}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: payload }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Submission failed: ${response.status} - ${errText}`);
  }

  const { prompt_id } = await response.json();
  console.log(`[Workflow] Prompt queued. ID: ${prompt_id}`);

  const startTime = Date.now();

  while (true) {
    await sleep(5000);
    const historyRes = await fetch(`${COMFY_HOST}/history/${prompt_id}`);
    if (historyRes.ok) {
      const historyData = await historyRes.json();
      if (historyData[prompt_id]) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n==============================================`);
        console.log(`[BENCHMARK] Rendering complete!`);
        console.log(`[BENCHMARK] Total Duration: ${duration}s`);
        console.log(`==============================================\n`);
        return duration;
      }
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`[Workflow] Processing video... Elapsed: ${elapsed}s`);
  }
}

// 5. Upload Result to Cloudflare R2
async function uploadToR2(filePath) {
  console.log(`[R2] Streaming video file to Cloudflare R2: ${filePath}`);
  const fileStream = createReadStream(filePath);
  const destinationKey = `test-output/test_run.mp4`;

  const uploadParams = {
    Bucket: R2_BUCKET_NAME,
    Key: destinationKey,
    Body: fileStream,
    ContentType: 'video/mp4',
  };

  await s3Client.send(new PutObjectCommand(uploadParams));
  console.log(`[R2] Upload complete: ${destinationKey}`);
}

// --- Main Pipeline ---
async function main() {
  const imageUrl = process.env.TEST_IMAGE_URL || DEFAULT_TEST_IMAGE_URL;

  try {
    await downloadTestImage(imageUrl);

    const rawJson = readFileSync(API_JSON_PATH, 'utf-8');
    const workflow = JSON.parse(rawJson);

    const freshSeed = Math.floor(Math.random() * 1000000000000000);
    console.log(`[Setup] Assigned random noise_seed: ${freshSeed}`);

    // Update image input node ("395": LoadImage)
    setNodeInputs(workflow, 'LoadImage', null, { image: 'test_input.jpg' });

    // Update RandomNoise seed nodes ("398:339" & "398:338")
    setNodeInputs(workflow, 'RandomNoise', null, { noise_seed: freshSeed });

    launchComfyUI();
    await waitForComfyReady();
    await executeWorkflow(workflow);

    const outputFiles = readdirSync(OUTPUT_DIR).filter((file) => file.endsWith('.mp4'));
    if (outputFiles.length === 0) {
      throw new Error(`[Error] No .mp4 file produced in ${OUTPUT_DIR}`);
    }

    const outputFile = join(OUTPUT_DIR, outputFiles[outputFiles.length - 1]);

    if (R2_ACCOUNT_ID && R2_BUCKET_NAME) {
      await uploadToR2(outputFile);
    } else {
      console.warn('[R2 Warning] R2 env vars missing. Skipping upload step.');
    }

    console.log('[Runner] Test complete. Exiting.');
    process.exit(0);
  } catch (err) {
    console.error('[Fatal Error]:', err);
    process.exit(1);
  }
}

main();