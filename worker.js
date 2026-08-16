import os from 'os';
import { readFileSync, createReadStream } from 'fs';
import { mkdir, writeFile, readdir, stat, unlink } from 'fs/promises';
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

// Identity strictly derived from the OS Hostname
const MACHINE_ID = os.hostname();
let WORKER_SECRET = null;
let HYPERSTACK_VM_ID = null;

// API Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'https://api.runltx.com';
const POLL_INTERVAL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS) || 5;
const MAX_RETRY_COUNT = 2;

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

const get_api_headers = () => ({
    'worker-auth': WORKER_SECRET,
    'content-type': 'application/json'
});

const get_hyperstack_headers = () => ({
    'api_key': HYPERSTACK_API_KEY,
    'content-type': 'application/json'
});

// ============================================
// Dynamic Registration & Cloud Discovery
// ============================================
const register_with_api = async () => {
    console.log(`[Worker Init] Registering hostname '${MACHINE_ID}' with central API (${API_BASE_URL})...`);

    while (!WORKER_SECRET) {
        try {
            const res = await fetch(`${API_BASE_URL}/v1/worker/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ MACHINE_ID })
            });

            const text = await res.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch (_) {
                data = { raw: text };
            }

            if (res.ok && data.STATUS === 'OK' && data.SECRET) {
                WORKER_SECRET = data.SECRET;
                console.log(`[Worker Init] Host '${MACHINE_ID}' authorized. Secret token established.`);
                return WORKER_SECRET;
            }

            console.error(`[Worker Init] Registration rejected (HTTP ${res.status}):`, JSON.stringify(data));
            console.log('[Worker Init] Retrying in 5 seconds...');
        } catch (err) {
            console.error(`[Worker Init] Connection error: ${err.message}. Retrying in 5s...`);
        }
        await sleep(5000);
    }
};

const resolve_hyperstack_vm_id = async () => {
    if (HYPERSTACK_VM_ID) return HYPERSTACK_VM_ID;
    if (!HYPERSTACK_API_KEY) {
        console.warn('[Hyperstack] HYPERSTACK_API_KEY missing. Skipping VM discovery.');
        return null;
    }

    try {
        console.log(`[Hyperstack] Querying VM ID for hostname '${MACHINE_ID}'...`);
        const res = await fetch(`${HYPERSTACK_API_URL}/core/virtual-machines`, {
            method: 'GET',
            headers: get_hyperstack_headers()
        });

        if (!res.ok) {
            const err_text = await res.text();
            throw new Error(`HTTP ${res.status}: ${err_text}`);
        }

        const data = await res.json();
        const instances = data.instances || [];
        const match = instances.find((vm) => vm.name.toLowerCase() === MACHINE_ID.toLowerCase());

        if (!match) {
            console.warn(`[Hyperstack] VM '${MACHINE_ID}' not found in active instances list.`);
            return null;
        }

        HYPERSTACK_VM_ID = match.id;
        console.log(`[Hyperstack] Discovered VM ID: ${HYPERSTACK_VM_ID} (Name: ${match.name})`);
        return HYPERSTACK_VM_ID;
    } catch (err) {
        console.error('[Hyperstack Discovery Error]:', err.message);
        return null;
    }
};

const hibernate_vm = async () => {
    try {
        const vm_id = await resolve_hyperstack_vm_id();
        if (!vm_id) throw new Error('Cannot hibernate: Hyperstack VM ID is missing.');

        console.log(`[Hibernate] Requesting hibernation for VM ${vm_id}...`);
        
        // GET /core/virtual-machines/{vm_id}/hibernate
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
        await sleep(2000);
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
        await sleep(3000);
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
                } else if (entry.name.endsWith('.mp4')) {
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

const cleanup_files = async (job_id) => {
    try { await unlink(join(INPUT_DIR, `${job_id}.jpg`)); } catch (_) {}
    const output_file = await find_latest_mp4(OUTPUT_DIR);
    if (output_file) {
        try { await unlink(output_file); } catch (_) {}
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

            const r2_url = await upload_to_r2(output_file, job_id);
            await complete_job(job_id, r2_url, generation_time);
            await cleanup_files(job_id);

            console.log(`[Job ${job_id}] Finished successfully in ${generation_time.toFixed(2)}s`);
            return true;
        } catch (err) {
            retry_count++;
            console.error(`[Job ${job_id}] Attempt ${retry_count} failed: ${err.message}`);

            if (retry_count >= MAX_RETRY_COUNT) {
                try { await fail_job(job_id, err.message); } catch (_) {}
                return false;
            }

            await sleep(retry_count * 5000);
        }
    }
    return false;
};

// ============================================
// Main Execution Entrypoint
// ============================================
const worker_loop = async () => {
    console.log(`[Worker] Started on host: ${MACHINE_ID}`);

    // 1. Handshake with API to get secret
    await register_with_api();

    // 2. Discover Cloud VM Info
    await resolve_hyperstack_vm_id();

    // 3. Prepare Workspaces
    await mkdir(INPUT_DIR, { recursive: true });
    await mkdir(OUTPUT_DIR, { recursive: true });

    // 4. Wait for ComfyUI
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
                    console.log('[Worker] Inactivity limit reached. Initiating VM hibernation...');
                    await hibernate_vm();
                    process.exit(0);
                }

                await sleep(POLL_INTERVAL_SECONDS * 1000);
                continue;
            }

            empty_poll_count = 0;
            await process_job(result.data);
            await sleep(2000);

        } catch (err) {
            console.error('[Worker] Loop error:', err.message);
            empty_poll_count++;
            await sleep(POLL_INTERVAL_SECONDS * 1000);
        }
    }
};

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

worker_loop().catch((err) => {
    console.error('[Worker] Fatal error:', err);
    process.exit(1);
});
