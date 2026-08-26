// worker.js

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
const WORKFLOW_MAP = {
  'ltx-i2v': join(process.cwd(), 'video_ltx2_5_i2v.json'),
  'ltx-t2v': join(process.cwd(), 'video_ltx2_5_t2v.json'),
  'ltx-flf2v': join(process.cwd(), 'video_ltx2_5_flf2v.json'),
};
const INPUT_DIR = join(process.cwd(), 'ComfyUI', 'input');
const OUTPUT_DIR = join(process.cwd(), 'ComfyUI', 'output');
const STATS_FILE = '/tmp/worker_stats.json';

// Machine identity and static secret from environment
const MACHINE_ID = os.hostname();
const WORKER_API_SECRET = process.env.WORKER_API_SECRET;

// Discovery cache: null = unprobed, false = not a hyperstack instance, string/number = VM ID
let HYPERSTACK_VM_ID = null;

// Track background upload tasks
const active_uploads = new Set();

// Telemetry counters
let total_jobs_processed = 0;
let total_generation_time_sec = 0;

// API Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'https://api.runltx.com';
const POLL_INTERVAL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS, 10) || 1;
const MAX_RETRY_COUNT = parseInt(process.env.MAX_RETRY_COUNT, 10) || 3;
const MAX_EMPTY_POLLS = 3;

// Hyperstack Configuration
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

const sync_stats_file = async () => {
  try {
    const stats = {
      jobs_processed: total_jobs_processed,
      total_generation_time_sec: Math.round(total_generation_time_sec * 100) / 100,
    };
    await writeFile(STATS_FILE, JSON.stringify(stats));
  } catch (_) {}
};

// Formats log details: [ job_id ] resolution, aspect ratio, seconds, fps and abbreviated prompt
const format_job_log = (meta) => {
  const short_prompt = (meta.prompt || 'No Prompt')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated_prompt = short_prompt.length > 50 
    ? `${short_prompt.slice(0, 47)}...` 
    : short_prompt;

  return `[ ${meta.job_id} ] ${meta.resolution} | ${meta.aspect_ratio} | ${meta.duration_sec}s | ${meta.fps}fps | "${truncated_prompt}"`;
};

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
      HYPERSTACK_VM_ID = false;
      return null;
    }

    HYPERSTACK_VM_ID = match.id;
    return HYPERSTACK_VM_ID;
  } catch (err) {
    HYPERSTACK_VM_ID = false;
    return null;
  }
};

const hibernate_vm = async () => {
  try {
    const vm_id = await resolve_hyperstack_vm_id();
    if (!vm_id) throw new Error('Cannot hibernate: Hyperstack VM ID is missing.');

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
    return data;
  } catch (err) {
    console.error('[Hibernate Error]:', err.message);
    return null;
  }
};

const flush_pending_uploads = async () => {
  if (active_uploads.size > 0) {
    console.log(`[Worker] Waiting for ${active_uploads.size} background upload(s) to finalize...`);
    await Promise.allSettled(Array.from(active_uploads));
    console.log('[Worker] All uploads resolved.');
  }
  await sync_stats_file();
};

const handle_inactivity_shutdown = async () => {
  console.log('[Worker] Inactivity limit reached. Initiating teardown...');
  await flush_pending_uploads();

  if (is_modal_runtime()) {
    process.exit(0);
  }

  const vm_id = await resolve_hyperstack_vm_id();
  if (vm_id) {
    await hibernate_vm();
    process.exit(0);
  }

  process.exit(0);
};

// ============================================
// API Operations
// ============================================
const poll_for_job = async (job_type, model) => {
  try {
    const url = `${API_BASE_URL}/v1/worker/get?job_type=${encodeURIComponent(job_type)}&models=${encodeURIComponent(model)}`;
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
      error_message: typeof error_message === 'string' ? error_message : (error_message?.message || 'Worker failure')
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
    await sleep(250);
  }
};


const mutate_workflow = (workflow, model, prompt, images, resolution = '720p', duration_seconds = 5, fps = 24) => {
  // Map standard resolution strings to megapixels 
  const resolution_map = {
    '720p': 0.9,
    '1080p': 2.1,
    '2k-hd': 3.7,
    '4k-hd': 8.3
  };
  const megapixels = resolution_map[resolution] || 0.9;
  
  const files = Array.isArray(images) ? images : [images];

  for (const [, node] of Object.entries(workflow)) {
    // 1. Duration, FPS, and Seed
    if (node.class_type === 'PrimitiveInt' && node._meta?.title === 'Duration') {
      node.inputs.value = duration_seconds;
    }
    if (node.class_type === 'PrimitiveInt' && (node._meta?.title === 'Frame Rate' || node._meta?.title === 'Frame Rate(int)')) {
      node.inputs.value = fps;
    }
    if (node.class_type === 'RandomNoise') {
      node.inputs.noise_seed = Math.floor(Math.random() * 1000000000000000);
    }

    // 2. Resolution (Megapixels)
    if (node.class_type === 'ResolutionSelector') {
      node.inputs.megapixels = megapixels;
    }

    // 3. Images
    if (node.class_type === 'LoadImage' && files.length > 0) {
      if (node._meta?.title === 'Load Last Frame' && files.length >= 2) {
        node.inputs.image = files[1];
      } else {
        node.inputs.image = files[0];
      }
    }

    // 4. Prompt (Removed the CLIPTextEncode overwrite to protect negative prompts and LLM links)
    if (node.class_type === 'PrimitiveStringMultiline' && node._meta?.title === 'Prompt') {
      node.inputs.value = prompt;
    }
  }

  return workflow;
};

// const update_workflow_duration = (workflow, duration_sec, fps = 24) => {
//   for (const [, node] of Object.entries(workflow)) {
//     // Reverted to exact match to avoid modifying unintended nodes
//     if (node.class_type === 'PrimitiveInt' && node._meta?.title === 'Duration') {
//       node.inputs.value = duration_sec;
//     }
//     if (node.class_type === 'PrimitiveInt' && node._meta?.title === 'Frame Rate') {
//       node.inputs.value = fps;
//     }
//     if (node.class_type === 'RandomNoise') {
//       node.inputs.noise_seed = Math.floor(Math.random() * 1000000000000000);
//     }
//   }
//   return workflow;
// };

// const set_workflow_image = (workflow, downloaded_filenames) => {
//   const files = Array.isArray(downloaded_filenames) ? downloaded_filenames : [downloaded_filenames];
//   if (files.length === 0) return workflow;

//   for (const [, node] of Object.entries(workflow)) {
//     if (node.class_type === 'LoadImage') {
//       if (node._meta?.title === 'Load Last Frame' && files.length >= 2) {
//         node.inputs.image = files[1];
//       } else {
//         node.inputs.image = files[0];
//       }
//     }
//   }
//   return workflow;
// };

// const set_workflow_prompt = (workflow, prompt_text) => {
//   for (const [, node] of Object.entries(workflow)) {
//     // Forcefully overwrite the text input (severs upstream LLM nodes to save ~2s)
//     if (node.class_type === 'CLIPTextEncode' && (!node._meta?.title || !node._meta.title.toLowerCase().includes('negative'))) {
//       node.inputs.text = prompt_text;
//     }
//     // Continue to support the multiline nodes used in ltx-t2v/flf2v
//     if (node.class_type === 'PrimitiveStringMultiline' && node._meta?.title === 'Prompt') {
//       node.inputs.value = prompt_text;
//     }
//   }
//   return workflow;
// };

const execute_workflow = async (workflow) => {
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
    await sleep(250);
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
// Filesystem & Storage Operations
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

const upload_and_complete_async = async (job_id, isolated_path, generation_time, downloaded_filenames = []) => {
  try {
    const r2_url = await upload_to_r2(isolated_path, job_id);
    await complete_job(job_id, r2_url, generation_time);
    console.log(`[Job ${job_id}] Upload & complete finished in background.`);
  } catch (err) {
    console.error(`[Job ${job_id}] Background upload/complete failed:`, err.message);
    try { await fail_job(job_id, err.message); } catch (_) {}
  } finally {
    try { await unlink(isolated_path); } catch (_) {}
    
    // Clean up dynamic files or fallback for safe backwards-compatibility
    if (downloaded_filenames.length === 0) {
      try { await unlink(join(INPUT_DIR, `${job_id}.jpg`)); } catch (_) {}
    } else {
      for (const fn of downloaded_filenames) {
        try { await unlink(join(INPUT_DIR, fn)); } catch (_) {}
      }
    }
  }
};

// ============================================
// Pipeline Step: Fetch & Prepare Task
// ============================================
const prepare_job = async (job_data) => {
  const { job_id, job_type, model, input } = job_data;
  
  // Extract parameters
  const duration_sec = input?.duration_sec ?? job_data.duration_sec ?? 5;
  const fps = input?.fps ?? job_data.fps ?? 24;
  const prompt = input?.prompt ?? job_data.prompt ?? '';
  const resolution = input?.resolution ?? job_data.resolution ?? '720p';
  const aspect_ratio = input?.aspect_ratio ?? job_data.aspect_ratio ?? '16:9';

  const model_id = model || 'ltx-i2v';
  const workflow_path = WORKFLOW_MAP[model_id];
  if (!workflow_path) {
    throw new Error(`Unsupported model identifier: ${model_id}`);
  }

  const images = (Array.isArray(input?.images) && input.images.length > 0)
    ? input.images
    : (input?.image_url ?? job_data.image_url ? [input?.image_url ?? job_data.image_url] : []);

  const downloaded_filenames = [];

  if (model_id === 'ltx-i2v') {
    if (images.length === 0) throw new Error('No valid image URL found in job payload');
    const image_filename = `${job_id}.jpg`;
    await download_image(images[0], image_filename);
    downloaded_filenames.push(image_filename);
  } else if (model_id === 'ltx-flf2v') {
    if (images.length < 2) throw new Error('ltx-flf2v requires at least 2 image URLs');
    const filename1 = `${job_id}_first.jpg`;
    const filename2 = `${job_id}_last.jpg`;
    await download_image(images[0], filename1);
    await download_image(images[1], filename2);
    downloaded_filenames.push(filename1, filename2);
  } 
  // ltx-t2v deliberately bypasses image downloading

  const raw_workflow = readFileSync(workflow_path, 'utf-8');
  let workflow = JSON.parse(raw_workflow);

  workflow = mutate_workflow(
    workflow, 
    model_id, 
    prompt, 
    downloaded_filenames, 
    resolution, 
    duration_sec, 
    fps
  );

  // workflow = update_workflow_duration(workflow, duration_sec, fps);
  // workflow = set_workflow_image(workflow, downloaded_filenames);
  // workflow = set_workflow_prompt(workflow, prompt);

  return {
    job_id,
    job_type,
    model: model_id,
    workflow,
    downloaded_filenames,
    meta: {
      job_id,
      resolution,
      aspect_ratio,
      duration_sec,
      fps,
      prompt
    }
  };
};

const prefetch_next_job = async (job_type, model) => {
  try {
    const result = await poll_for_job(job_type, model);
    if (!result || !result.success || !result.data) {
      return null;
    }

    try {
      const prepared_job = await prepare_job(result.data);
      console.log(`[Prefetched] ${format_job_log(prepared_job.meta)}`);
      return prepared_job;
    } catch (prep_err) {
      console.error(`[Job ${result.data.job_id}] Preparation failed:`, prep_err.message);
      try { await fail_job(result.data.job_id, prep_err.message); } catch (_) {}
      return null;
    }
  } catch (err) {
    console.error('[Pipeline] Prefetch error:', err.message);
    return null;
  }
};

// ============================================
// Main Execution Loop
// ============================================
const worker_loop = async () => {
  console.log(`[Worker] Started on host: ${MACHINE_ID}`);

  if (!WORKER_API_SECRET) {
    console.error('[Worker Fatal] WORKER_API_SECRET environment variable is missing.');
    process.exit(1);
  }

  await mkdir(INPUT_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  await sync_stats_file();

  await wait_for_comfy_ready();

  const job_type = process.env.JOB_TYPE || 'generate';
  // If user passes a default fallback model, grab it - otherwise poll for all supported
  const model = process.env.MODEL || Object.keys(WORKFLOW_MAP).join(',');

  let current_job = null;
  let prefetch_promise = null;
  let empty_poll_count = 0;

  console.log(`[Worker] Polling for jobs every ${POLL_INTERVAL_SECONDS}s...`);

  while (true) {
    try {
      // 1. Resolve or fetch the active job to render
      if (prefetch_promise) {
        current_job = await prefetch_promise;
        prefetch_promise = null;
      }

      if (!current_job) {
        current_job = await prefetch_next_job(job_type, model);
      }

      // 2. Inactivity tracking
      if (!current_job) {
        empty_poll_count++;
        console.log(`[Worker] No jobs available (${empty_poll_count}/${MAX_EMPTY_POLLS})`);

        if (empty_poll_count >= MAX_EMPTY_POLLS) {
          await handle_inactivity_shutdown();
        }

        await sleep(POLL_INTERVAL_SECONDS * 1000);
        continue;
      }

      empty_poll_count = 0;
      
      // Log job start with resolution, aspect ratio, duration, fps, and prompt
      console.log(`[GPU Render] ${format_job_log(current_job.meta)}`);

      // 3. Immediately kick off prefetch for Job N+1 in parallel with GPU generation
      prefetch_promise = prefetch_next_job(job_type, model);

      // 4. Render Job N
      let generation_time = 0;
      let render_success = false;

      try {
        generation_time = await execute_workflow(current_job.workflow);
        render_success = true;
      } catch (render_err) {
        console.error(`[Job ${current_job.job_id}] Render failed:`, render_err.message);
        try { await fail_job(current_job.job_id, render_err.message); } catch (_) {}
      }

      // 5. Isolate MP4 & delegate upload to non-blocking background task
      if (render_success) {
        const output_file = await find_latest_mp4(OUTPUT_DIR);
        if (output_file) {
          const isolated_path = join(OUTPUT_DIR, `uploading_${current_job.job_id}.mp4`);
          await rename(output_file, isolated_path);

          total_jobs_processed++;
          total_generation_time_sec += generation_time;
          await sync_stats_file();

          console.log(`[Job ${current_job.job_id}] Rendered in ${generation_time.toFixed(2)}s. Queuing async upload.`);
          const upload_task = upload_and_complete_async(current_job.job_id, isolated_path, generation_time, current_job.downloaded_filenames);
          active_uploads.add(upload_task);
          upload_task.finally(() => active_uploads.delete(upload_task));
        } else {
          console.error(`[Job ${current_job.job_id}] Output MP4 was not found.`);
          try { await fail_job(current_job.job_id, 'Generated MP4 missing'); } catch (_) {}
        }
      }

      // Clear current job slot so next iteration immediately grabs the prefetched job
      current_job = null;

    } catch (err) {
      console.error('[Worker] Unexpected error in main loop:', err.message);
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
