import os from 'os';
import { readFileSync, createReadStream } from 'fs';
import { mkdir, writeFile, readdir, stat, unlink, rename } from 'fs/promises';
import { join } from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// ============================================
// CONSTANTS & IDENTITY
// ============================================
const COMFY_PORT = 8188;
const COMFY_HOST = `http://127.0.0.1:${COMFY_PORT}`;
const WORKFLOW_PATH = join(process.cwd(), 'video_ltx2_5_i2v.json');
const INPUT_DIR = join(process.cwd(), 'ComfyUI', 'input');
const OUTPUT_DIR = join(process.cwd(), 'ComfyUI', 'output');

// Machine identity and static secret from environment
const MACHINE_ID = os.hostname();
const WORKER_API_SECRET = process.env.WORKER_API_SECRET;

// Discovery cache: null = unprobed, false = not a hyperstack instance, string/number = VM ID
let HYPERSTACK_VM_ID = null;

// Track active background uploads to prevent shutdown race conditions
const active_uploads = new Set();

// API Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'https://api.runltx.com';
const POLL_INTERVAL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS, 10) || 1;
const MAX_RETRY_COUNT = parseInt(process.env.MAX_RETRY_COUNT, 10) || 3;

// Hyperstack Configuration (Optional, for bare-metal/VM self-hibernation)
const HYPERSTACK_API_URL = process.env.HYPERSTACK_API_URL || 'https://infrahub-api.nexgencloud.com/v1';
const HYPERSTACK_API_KEY = process.env.HYPERSTACK_API_KEY;

// R2 Configuration
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_CDN_URL = process.env.R2_CDN_URL;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  console.warn('[Config Warning] Missing one or more R2 credentials.');
}

// ============================================
// R2 Client
// ============================================
const s3_client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || '',
    secretAccessKey: R2_SECRET_ACCESS_KEY || '',
  },
});

// ============================================
// Helper Functions
// ============================================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const is_modal_runtime = () => {
  return Boolean(
    process.env.MODAL_TASK_ID ||
    process.env.MODAL_IS_REMOTE ||
    process.env.MODAL_ENVIRONMENT
  );
};

const get_api_headers = () => ({
  'worker-auth': WORKER_API_SECRET,
  'x-machine-id': MACHINE_ID,
  'content-type': 'application/json'
});

const get_hyperstack_headers = () => ({
  'api_key': HYPERSTACK_API_KEY,
  'content-type': 'application/json'
});

// ============================================
// Cloud Discovery & Teardown Handlers
// ============================================
const resolve_hyperstack_vm_id = async () => {
  if (HYPERSTACK_VM_ID !== null) return HYPERSTACK_VM_ID;

  if (is_modal_runtime() || !HYPERSTACK_API_KEY) {
    HYPERSTACK_VM_ID = false;
    return null;
  }

  try {
    console.log(`[Hyperstack] Checking if hostname '${MACHINE_ID}' exists in Hyperstack account...`);
    const res = await fetch(`${HYPERSTACK_API_URL}/core/virtual-machines`, {
      method: 'GET',
      headers: get_hyperstack_headers()
    });

    if (!res.ok) {
      HYPERSTACK_VM_ID = false;
      return null;
    }

    const data = await res.json();
    const instances = data.instances || [];
    const match = instances.find((vm) => vm.name?.toLowerCase() === MACHINE_ID.toLowerCase());

    if (!match) {
      console.log(`[Platform Detection] Host '${MACHINE_ID}' not in Hyperstack inventory. Disabling Hyperstack hibernation.`);
      HYPERSTACK_VM_ID = false;
      return null;
    }

    HYPERSTACK_VM_ID = match.id;
    console.log(`[Platform Detection] Hyperstack VM verified (ID: ${HYPERSTACK_VM_ID})`);
    return HYPERSTACK_VM_ID;
  } catch (err) {
    console.warn('[Hyperstack Discovery Failed]:', err.message);
    HYPERSTACK_VM_ID = false;
    return null;
  }
};

const hibernate_vm = async () => {
  try {
    const vm_id = await resolve_hyperstack_vm_id();
    if (!vm_id) throw new Error('Cannot hibernate: Hyperstack VM ID is missing.');

    console.log(`[Hibernate] Requesting hibernation for VM ${vm_id}...`);
    const url = `${HYPERSTACK_API_URL}/core/virtual-machines/${vm_id}/hibernate?retain_ip=true`;
    const res = await fetch(url, {
      method: 'GET',
      headers: get_hyperstack_headers()
    });

    if (!res.ok) {
      const err_text = await res.text();
      throw new Error(`HTTP ${res.status}: ${err_text}`);
    }

    const data = await res.json();
    console.log('[Hibernate] VM hibernation successfully initiated:', data);
    return data;
  } catch (err) {
    console.error('[Hibernate Error]:', err.message);
    return null;
  }
};

const flush_pending_uploads = async () => {
  if (active_uploads.size > 0) {
    console.log(`[Worker] Waiting for ${active_uploads.size} background upload(s) to complete before teardown...`);
    await Promise.allSettled(Array.from(active_uploads));
    console.log('[Worker] All background uploads resolved.');
  }
};

const handle_inactivity_shutdown = async () => {
  console.log('[Worker] Inactivity limit reached. Initiating teardown...');
  await flush_pending_uploads();

  if (is_modal_runtime()) {
    console.log('[Teardown: Modal] Serverless task finished. Exiting container.');
    process.exit(0);
  }

  const vm_id = await resolve_hyperstack_vm_id();
  if (vm_id) {
    console.log(`[Teardown: Hyperstack] Hibernating Hyperstack VM ${vm_id}...`);
    await hibernate_vm();
    process.exit(0);
  }

  console.log('[Teardown: Generic] Exiting worker process.');
  process.exit(0);
};

// ============================================
// API Task Operations
// ============================================
const poll_for_job = async (job_type, model) => {
  try {
    const url = `${API_BASE_URL}/v1/worker/get?job_type=${job_type}&model=${model}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: get_api_headers()
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      const err_text = await response.text();
      throw new Error(`HTTP ${response.status}: ${err_text}`);
    }

    return await response.json();
  } catch (err) {
    console.error('[API Poll Error]:', err.message);
    return null;
  }
};

const complete_job = async (job_id, output_url, generation_time_sec) => {
  const url = `${API_BASE_URL}/v1/worker/complete`;
  const response = await fetch(url, {
    method: 'POST',
    headers: get_api_headers(),
    body: JSON.stringify({
      job_id,
      output_url,
      generation_time_sec
    })
  });

  if (!response.ok) {
    const err_text = await response.text();
    throw new Error(`HTTP ${response.status}: ${err_text}`);
  }

  return await response.json();
};

const fail_job = async (job_id, error_message) => {
  const url = `${API_BASE_URL}/v1/worker/fail`;
  const response = await fetch(url, {
    method: 'POST',
    headers: get_api_headers(),
    body: JSON.stringify({
      job_id,
      error_message
    })
  });

  if (!response.ok) {
    const err_text = await response.text();
    throw new Error(`HTTP ${response.status}: ${err_text}`);
  }

  return await response.json();
};

// ============================================
// ComfyUI Engine
// ============================================
const wait_for_comfy_ready = async () => {
  console.log('[ComfyUI] Probing server readiness on port 8188...');
  const health_url = `${COMFY_HOST}/history`;

  while (true) {
    try {
      const res = await fetch(health_url);
      if (res.ok) {
        console.log('[ComfyUI] Server online and responsive.');
        break;
      }
    } catch (_) {}
    await sleep(500);
  }
};

const update_workflow_duration = (workflow, duration_seconds, fps = 24) => {
  for (const [node_id, node] of Object.entries(workflow)) {
    if (node.class_type === 'PrimitiveInt' && node._meta?.title === 'Duration') {
      node.inputs.value = duration_seconds;
    }
    if (node.class_type === 'PrimitiveInt' && node._meta?.title === 'Frame Rate') {
      node.inputs.value = fps;
    }
    if (node.class_type === 'RandomNoise') {
      node.inputs.noise_seed = Math.floor(Math.random() * 1000000000000000);
    }
  }
  return workflow;
};

const set_workflow_image = (workflow, image_filename) => {
  for (const [node_id, node] of Object.entries(workflow)) {
    if (node.class_type === 'LoadImage') {
      node.inputs.image = image_filename;
    }
  }
  return workflow;
};

const set_workflow_prompt = (workflow, prompt_text) => {
  for (const [node_id, node] of Object.entries(workflow)) {
    if (node.class_type === 'CLIPTextEncode' && (!node._meta?.title || !node._meta.title.toLowerCase().includes('negative'))) {
      node.inputs.text = prompt_text;
    }
  }
  return workflow;
};

const execute_workflow = async (workflow, job_id) => {
  const response = await fetch(`${COMFY_HOST}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });

  if (!response.ok) {
    const err_text = await response.text();
    throw new Error(`Workflow rejection: ${response.status} - ${err_text}`);
  }

  const { prompt_id } = await response.json();
  const start_time = Date.now();

  while (true) {
    await sleep(1000);
    const history_res = await fetch(`${COMFY_HOST}/history/${prompt_id}`);

    if (history_res.ok) {
      const history_data = await history_res.json();
      if (history_data[prompt_id]) {
        return (Date.now() - start_time) / 1000;
      }
    }
  }
};

// ============================================
// Filesystem & S3 Operations
// ============================================
const find_latest_mp4 = async (dir) => {
  const files = [];
  const walk = async (current_dir) => {
    try {
      const entries = await readdir(current_dir, { withFileTypes: true });
      for (const entry of entries) {
        const full_path = join(current_dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full_path);
        } else if (entry.name.endsWith('.mp4') && !entry.name.startsWith('uploading_')) {
          const stats = await stat(full_path);
          files.push({ path: full_path, mtime: stats.mtime });
        }
      }
    } catch (_) {}
  };

  await walk(dir);
  if (files.length === 0) return null;
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return files[0].path;
};

const download_image = async (url, filename) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed: ${res.statusText}`);
  const buffer = await res.arrayBuffer();
  await mkdir(INPUT_DIR, { recursive: true });
  const image_path = join(INPUT_DIR, filename);
  await writeFile(image_path, Buffer.from(buffer));
  return image_path;
};

const upload_to_r2 = async (file_path, job_id) => {
  const key = `generations/${job_id}.mp4`;
  const file_stream = createReadStream(file_path);

  await s3_client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: file_stream,
    ContentType: 'video/mp4',
  }));

  return `${R2_CDN_URL}/${key}`;
};

// ============================================
// Background Upload Task Runner
// ============================================
const upload_and_complete_async = async (job_id, isolated_path, generation_time) => {
  const input_file = join(INPUT_DIR, `${job_id}.jpg`);
  try {
    const r2_url = await upload_to_r2(isolated_path, job_id);
    await complete_job(job_id, r2_url, generation_time);
    console.log(`[Job ${job_id}] Upload & complete finalized successfully in background.`);
  } catch (err) {
    console.error(`[Job ${job_id}] Background upload/complete failed:`, err.message);
    try { await fail_job(job_id, err.message); } catch (_) {}
  } finally {
    try { await unlink(isolated_path); } catch (_) {}
    try { await unlink(input_file); } catch (_) {}
  }
};

// ============================================
// Job Orchestrator
// ============================================
const process_job = async (job_data) => {
  const { job_id, image_url, duration_sec, prompt, job_type, model } = job_data;
  let retry_count = 0;

  console.log(`[Job ${job_id}] Processing (${job_type}/${model}) - Duration: ${duration_sec}s`);

  while (retry_count < MAX_RETRY_COUNT) {
    try {
      const image_filename = `${job_id}.jpg`;
      await download_image(image_url, image_filename);

      const raw_workflow = readFileSync(WORKFLOW_PATH, 'utf-8');
      let workflow = JSON.parse(raw_workflow);

      workflow = update_workflow_duration(workflow, duration_sec);
      workflow = set_workflow_image(workflow, image_filename);
      workflow = set_workflow_prompt(workflow, prompt);

      const generation_time = await execute_workflow(workflow, job_id);
      const output_file = await find_latest_mp4(OUTPUT_DIR);

      if (!output_file) throw new Error('Generation finished but MP4 was not found.');

      // 1. Immediately rename and isolate file so next job cannot touch it
      const isolated_path = join(OUTPUT_DIR, `uploading_${job_id}.mp4`);
      await rename(output_file, isolated_path);

      console.log(`[Job ${job_id}] Finished generation in ${generation_time.toFixed(2)}s. Offloaded upload to background.`);

      // 2. Fire and track background upload (Zero GPU blocking)
      const upload_task = upload_and_complete_async(job_id, isolated_path, generation_time);
      active_uploads.add(upload_task);
      upload_task.finally(() => active_uploads.delete(upload_task));

      // 3. Immediately return true so loop starts next video
      return true;
    } catch (err) {
      retry_count++;
      console.error(`[Job ${job_id}] Attempt ${retry_count} failed: ${err.message}`);

      if (retry_count >= MAX_RETRY_COUNT) {
        try { await fail_job(job_id, err.message); } catch (_) {}
        try { await unlink(join(INPUT_DIR, `${job_id}.jpg`)); } catch (_) {}
        return false;
      }

      await sleep(retry_count * 3000);
    }
  }
  return false;
};

// ============================================
// Main Execution Entrypoint
// ============================================
const worker_loop = async () => {
  console.log(`[Worker] Started on host: ${MACHINE_ID}`);

  if (!WORKER_API_SECRET) {
    console.error('[Worker Fatal] WORKER_API_SECRET environment variable is missing.');
    process.exit(1);
  }

  // 1. Prepare Workspaces
  await mkdir(INPUT_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  // 2. Wait for ComfyUI
  await wait_for_comfy_ready();

  let empty_poll_count = 0;
  const MAX_EMPTY_POLLS = 3;

  console.log(`[Worker] Polling for jobs every ${POLL_INTERVAL_SECONDS}s...`);

  while (true) {
    try {
      const job_type = process.env.JOB_TYPE || 'generate';
      const model = process.env.MODEL || 'ltx-i2v';

      const result = await poll_for_job(job_type, model);

      if (!result || !result.success) {
        empty_poll_count++;
        console.log(`[Worker] No jobs available (${empty_poll_count}/${MAX_EMPTY_POLLS})`);

        if (empty_poll_count >= MAX_EMPTY_POLLS) {
          await handle_inactivity_shutdown();
        }

        await sleep(POLL_INTERVAL_SECONDS * 1000);
        continue;
      }

      empty_poll_count = 0;
      await process_job(result.data);

    } catch (err) {
      console.error('[Worker] Loop error:', err.message);
      empty_poll_count++;
      await sleep(POLL_INTERVAL_SECONDS * 1000);
    }
  }
};

const handle_exit = async () => {
  console.log('[Worker] Termination signal received.');
  await flush_pending_uploads();
  process.exit(0);
};

process.on('SIGINT', handle_exit);
process.on('SIGTERM', handle_exit);

worker_loop().catch((err) => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});
