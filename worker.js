import { readFileSync, createReadStream } from 'fs';
import { mkdir, writeFile, readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// ============================================
// CONSTANTS
// ============================================
const COMFY_PORT = 8188;
const COMFY_HOST = `http://127.0.0.1:${COMFY_PORT}`;
const WORKFLOW_PATH = join(process.cwd(), 'video_ltx2_5_i2v.json');
const INPUT_DIR = join(process.cwd(), 'ComfyUI', 'input');
const OUTPUT_DIR = join(process.cwd(), 'ComfyUI', 'output');

// API Configuration (from environment)
const API_BASE_URL = process.env.API_BASE_URL || 'https://api.runltx.com';
const WORKER_SECRET = process.env.WORKER_SECRET;
const WORKER_ID = process.env.WORKER_ID || 'LTX-I2V-001';
const POLL_INTERVAL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS) || 5;
const MAX_RETRY_COUNT = parseInt(process.env.MAX_RETRY_COUNT) || 3;

// Hyperstack Configuration
const HYPERSTACK_API_URL = process.env.HYPERSTACK_API_URL || 'https://infrahub-api.nexgencloud.com/v1';
const HYPERSTACK_API_KEY = process.env.HYPERSTACK_API_KEY;
let resolved_vm_id = process.env.HYPERSTACK_VM_ID ? parseInt(process.env.HYPERSTACK_VM_ID) : null;

// R2 Configuration
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_CDN_URL = process.env.R2_CDN_URL;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    console.warn('[R2 Config Warning] One or more R2 environment variables are missing!');
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

const get_api_headers = () => ({
    'worker-auth': WORKER_SECRET,
    'content-type': 'application/json'
});

const get_hyperstack_headers = () => ({
    'api_key': HYPERSTACK_API_KEY,
    'content-type': 'application/json'
});

// ============================================
// Hyperstack Dynamic Discovery & Hibernation
// ============================================
const get_or_discover_vm_id = async () => {
    if (resolved_vm_id) {
        return resolved_vm_id;
    }

    try {
        console.log(`[Hyperstack] Auto-discovering VM ID for worker '${WORKER_ID}'...`);
        const url = `${HYPERSTACK_API_URL}/core/virtual-machines`;
        const response = await fetch(url, {
            method: 'GET',
            headers: get_hyperstack_headers()
        });

        if (!response.ok) {
            const err_text = await response.text();
            throw new Error(`Hyperstack list VMs error ${response.status}: ${err_text}`);
        }

        const data = await response.json();
        const vms = data.virtual_machines || data.instances || data.data || [];

        // Match VM by worker name or fallback to the only running VM
        const matched_vm = vms.find((vm) => vm.name === WORKER_ID) || vms[0];

        if (!matched_vm || !matched_vm.id) {
            throw new Error(`Could not locate VM for WORKER_ID='${WORKER_ID}' in Hyperstack account`);
        }

        resolved_vm_id = matched_vm.id;
        console.log(`[Hyperstack] Successfully discovered VM ID: ${resolved_vm_id} (Name: ${matched_vm.name})`);
        return resolved_vm_id;
    } catch (err) {
        console.error('[Hyperstack Discovery Error]:', err.message);
        return null;
    }
};

const hibernate_vm = async () => {
    try {
        const vm_id = await get_or_discover_vm_id();
        if (!vm_id) {
            throw new Error('Unable to hibernate: VM ID could not be determined.');
        }

        console.log(`[Hibernate] Hibernating VM ${vm_id} via Hyperstack API...`);
        const url = `${HYPERSTACK_API_URL}/core/virtual-machines/${vm_id}/hibernate?retain_ip=true`;
        const response = await fetch(url, {
            method: 'POST',
            headers: get_hyperstack_headers()
        });

        if (!response.ok) {
            const err_text = await response.text();
            throw new Error(`Hyperstack error ${response.status}: ${err_text}`);
        }

        const data = await response.json();
        console.log('[Hibernate] VM hibernation requested successfully:', data);
        return data;
    } catch (err) {
        console.error('[Hibernate] Error:', err.message);
        return null;
    }
};

// ============================================
// API Calls
// ============================================
const poll_for_job = async (job_type, model) => {
    try {
        const url = `${API_BASE_URL}/v1/worker/get?job_type=${job_type}&model=${model}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: get_api_headers()
        });

        if (response.status === 404) {
            return null; // No jobs available
        }

        if (!response.ok) {
            const err_text = await response.text();
            throw new Error(`API error ${response.status}: ${err_text}`);
        }

        const data = await response.json();
        return data;
    } catch (err) {
        console.error('[API] Poll error:', err.message);
        return null;
    }
};

const complete_job = async (job_id, output_url, generation_time_sec) => {
    try {
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
            throw new Error(`Complete error ${response.status}: ${err_text}`);
        }

        return await response.json();
    } catch (err) {
        console.error('[API] Complete error:', err.message);
        throw err;
    }
};

const fail_job = async (job_id, error_message) => {
    try {
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
            throw new Error(`Fail error ${response.status}: ${err_text}`);
        }

        return await response.json();
    } catch (err) {
        console.error('[API] Fail error:', err.message);
        throw err;
    }
};

// ============================================
// ComfyUI Functions
// ============================================
const wait_for_comfy_ready = async () => {
    console.log('[ComfyUI] Waiting for API endpoint readiness...');
    const health_url = `${COMFY_HOST}/history`;

    while (true) {
        try {
            const res = await fetch(health_url);
            if (res.ok) {
                console.log('[ComfyUI] Server online.');
                break;
            }
        } catch (_) {
            // Waiting for server startup
        }
        await sleep(2000);
    }
};

const update_workflow_duration = (workflow, duration_seconds, fps = 24) => {
    for (const [node_id, node] of Object.entries(workflow)) {
        if (node.class_type === 'PrimitiveInt' && node._meta?.title === 'Duration') {
            node.inputs.value = duration_seconds;
            console.log(`[Workflow] Updated Duration to ${duration_seconds} seconds`);
        }
        if (node.class_type === 'PrimitiveInt' && node._meta?.title === 'Frame Rate') {
            node.inputs.value = fps;
            console.log(`[Workflow] Updated Frame Rate to ${fps} fps`);
        }
        if (node.class_type === 'RandomNoise') {
            const fresh_seed = Math.floor(Math.random() * 1000000000000000);
            node.inputs.noise_seed = fresh_seed;
            console.log(`[Workflow] Updated seed to ${fresh_seed}`);
        }
        if (node.class_type === 'ComfyMathExpression' && node._meta?.title === 'Math Expression (length)') {
            if (node.inputs.values && node.inputs.values.a) {
                console.log(`[Workflow] Math Expression: ${duration_seconds} × ${fps} + 1 = ${duration_seconds * fps + 1} frames`);
            }
        }
    }
    return workflow;
};

const set_workflow_image = (workflow, image_filename) => {
    for (const [node_id, node] of Object.entries(workflow)) {
        if (node.class_type === 'LoadImage') {
            node.inputs.image = image_filename;
            console.log(`[Workflow] Set input image to: ${image_filename}`);
        }
    }
    return workflow;
};

const set_workflow_prompt = (workflow, prompt_text) => {
    for (const [node_id, node] of Object.entries(workflow)) {
        if (node.class_type === 'CLIPTextEncode' && (!node._meta?.title || !node._meta.title.toLowerCase().includes('negative'))) {
            node.inputs.text = prompt_text;
            console.log(`[Workflow] Set positive prompt to: ${prompt_text.substring(0, 60)}...`);
        }
    }
    return workflow;
};

const execute_workflow = async (workflow, job_id) => {
    console.log(`[Job ${job_id}] Submitting JSON prompt payload...`);

    const response = await fetch(`${COMFY_HOST}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow }),
    });

    if (!response.ok) {
        const err_text = await response.text();
        throw new Error(`Workflow submission failed: ${response.status} - ${err_text}`);
    }

    const { prompt_id } = await response.json();
    console.log(`[Job ${job_id}] Prompt queued. ID: ${prompt_id}`);

    const start_time = Date.now();

    while (true) {
        await sleep(4000);
        const history_res = await fetch(`${COMFY_HOST}/history/${prompt_id}`);

        if (history_res.ok) {
            const history_data = await history_res.json();
            if (history_data[prompt_id]) {
                const duration = (Date.now() - start_time) / 1000;
                console.log(`[Job ${job_id}] Rendering complete! Time: ${duration.toFixed(2)}s`);
                return duration;
            }
        }

        const elapsed = ((Date.now() - start_time) / 1000).toFixed(0);
        console.log(`[Job ${job_id}] Processing video... Elapsed: ${elapsed}s`);
    }
};

// ============================================
// File Helper Functions
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
                } else if (entry.name.endsWith('.mp4')) {
                    const stats = await stat(full_path);
                    files.push({ path: full_path, mtime: stats.mtime });
                }
            }
        } catch (err) {
            // Directory might not exist
        }
    };

    await walk(dir);

    if (files.length === 0) return null;

    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return files[0].path;
};

const download_image = async (url, filename) => {
    console.log(`[Download] Fetching image from ${url}...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);
    const buffer = await res.arrayBuffer();
    await mkdir(INPUT_DIR, { recursive: true });
    const image_path = join(INPUT_DIR, filename);
    await writeFile(image_path, Buffer.from(buffer));
    console.log(`[Download] Image saved to ${image_path}`);
    return image_path;
};

const upload_to_r2 = async (file_path, job_id) => {
    const key = `generations/${job_id}.mp4`;
    console.log(`[R2] Uploading ${key}...`);

    const file_stream = createReadStream(file_path);

    await s3_client.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: file_stream,
        ContentType: 'video/mp4',
    }));

    const url = `${R2_CDN_URL}/${key}`;
    console.log(`[R2] Upload complete: ${url}`);
    return url;
};

const cleanup_files = async (job_id) => {
    const image_path = join(INPUT_DIR, `${job_id}.jpg`);
    try {
        await unlink(image_path);
        console.log(`[Cleanup] Deleted input: ${image_path}`);
    } catch (_) {
        // File might not exist
    }

    const output_file = await find_latest_mp4(OUTPUT_DIR);
    if (output_file) {
        try {
            await unlink(output_file);
            console.log(`[Cleanup] Deleted output: ${output_file}`);
        } catch (_) {
            // File might not exist
        }
    }
};

// ============================================
// Job Processing
// ============================================
const process_job = async (job_data) => {
    const job_id = job_data.job_id;
    const image_url = job_data.image_url;
    const duration_sec = job_data.duration_sec;
    const prompt = job_data.prompt;
    const job_type = job_data.job_type;
    const model = job_data.model;
    let retry_count = 0;

    console.log(`[Job ${job_id}] Processing ${job_type}/${model} - ${duration_sec}s video`);
    console.log(`[Job ${job_id}] Prompt: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`);

    while (retry_count < MAX_RETRY_COUNT) {
        try {
            // Step 1: Download input image
            const image_filename = `${job_id}.jpg`;
            await download_image(image_url, image_filename);

            // Step 2: Load and modify workflow
            console.log(`[Job ${job_id}] Loading workflow...`);
            const raw_workflow = readFileSync(WORKFLOW_PATH, 'utf-8');
            let workflow = JSON.parse(raw_workflow);

            workflow = update_workflow_duration(workflow, duration_sec);
            workflow = set_workflow_image(workflow, image_filename);
            workflow = set_workflow_prompt(workflow, prompt);

            // Step 3: Execute workflow
            console.log(`[Job ${job_id}] Executing ComfyUI workflow...`);
            const generation_time = await execute_workflow(workflow, job_id);

            // Step 4: Find output video
            console.log(`[Job ${job_id}] Looking for output video...`);
            const output_file = await find_latest_mp4(OUTPUT_DIR);

            if (!output_file) {
                throw new Error('No MP4 output file found');
            }

            console.log(`[Job ${job_id}] Output file found: ${output_file}`);

            // Step 5: Upload to R2
            console.log(`[Job ${job_id}] Uploading to R2...`);
            const r2_url = await upload_to_r2(output_file, job_id);

            // Step 6: Complete job via API
            console.log(`[Job ${job_id}] Marking job as complete...`);
            await complete_job(job_id, r2_url, generation_time);

            // Step 7: Clean up files
            await cleanup_files(job_id);

            console.log(`[Job ${job_id}] ✅ COMPLETED SUCCESSFULLY`);
            return true;

        } catch (err) {
            retry_count++;
            console.error(`[Job ${job_id}] Error (attempt ${retry_count}/${MAX_RETRY_COUNT}):`, err.message);

            if (retry_count >= MAX_RETRY_COUNT) {
                console.error(`[Job ${job_id}] ❌ FAILED after ${MAX_RETRY_COUNT} attempts`);
                try {
                    await fail_job(job_id, err.message);
                } catch (_) {
                    // Fail error already logged
                }
                return false;
            }

            const wait_time = retry_count * 5;
            console.log(`[Job ${job_id}] Waiting ${wait_time}s before retry...`);
            await sleep(wait_time * 1000);
        }
    }

    return false;
};

// ============================================
// Main Worker Loop
// ============================================
const worker_loop = async () => {
    console.log(`[Worker] Starting (ID: ${WORKER_ID})`);

    // Pre-resolve VM ID in background on startup
    get_or_discover_vm_id().catch(() => {});

    // Ensure directories exist
    await mkdir(INPUT_DIR, { recursive: true });
    await mkdir(OUTPUT_DIR, { recursive: true });
    console.log(`[Worker] Input dir: ${INPUT_DIR}`);
    console.log(`[Worker] Output dir: ${OUTPUT_DIR}`);

    // Wait for ComfyUI
    await wait_for_comfy_ready();

    console.log(`[Worker] Polling every ${POLL_INTERVAL_SECONDS}s`);
    console.log(`[Worker] API: ${API_BASE_URL}`);

    let empty_poll_count = 0;
    const MAX_EMPTY_POLLS = 3;

    while (true) {
        try {
            const job_type = process.env.JOB_TYPE || 'generate';
            const model = process.env.MODEL || 'ltx-i2v';

            console.log(`[Worker] Polling for ${job_type}/${model}...`);
            const result = await poll_for_job(job_type, model);

            if (!result || !result.success) {
                empty_poll_count++;
                console.log(`[Worker] No jobs available (${empty_poll_count}/${MAX_EMPTY_POLLS})`);

                if (empty_poll_count >= MAX_EMPTY_POLLS) {
                    console.log('[Worker] No jobs for a while, hibernating VM directly...');

                    await hibernate_vm();

                    console.log('[Worker] VM hibernation requested, exiting...');
                    process.exit(0);
                }

                await sleep(POLL_INTERVAL_SECONDS * 1000);
                continue;
            }

            // Reset empty counter
            empty_poll_count = 0;

            // Process the job
            const job_data = result.data;
            const success = await process_job(job_data);

            if (success) {
                console.log('[Worker] Job processed successfully, checking for more...');
            } else {
                console.log('[Worker] Job failed, continuing...');
            }

            await sleep(2000);

        } catch (err) {
            console.error('[Worker] Loop error:', err.message);
            empty_poll_count++;
            await sleep(POLL_INTERVAL_SECONDS * 1000);
        }
    }
};

// ============================================
// Graceful Shutdown
// ============================================
const graceful_shutdown = async () => {
    console.log('[Worker] Received shutdown signal, exiting...');
    process.exit(0);
};

process.on('SIGINT', graceful_shutdown);
process.on('SIGTERM', graceful_shutdown);

// ============================================
// Start Worker
// ============================================
worker_loop().catch((err) => {
    console.error('[Worker] Fatal error:', err);
    process.exit(1);
});
