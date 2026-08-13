import { spawn } from 'child_process';
import { readFileSync, readdirSync, createReadStream } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// --- Configuration ---
const comfy_port = 8188;
const comfy_host = `http://127.0.0.1:${comfy_port}`;
const api_json_path = join(process.cwd(), 'video_ltx2_5_i2v.json');
const input_dir = join(process.cwd(), 'ComfyUI', 'input');
const output_dir = join(process.cwd(), 'ComfyUI', 'output');
const test_image_path = join(input_dir, 'test_input.jpg');
const default_test_image_url = 'https://picsum.photos/1024/576.jpg';

// --- R2 Credentials & Validation ---
const {
  r2_account_id,
  r2_access_key_id,
  r2_secret_access_key,
  r2_bucket_name
} = process.env;

if (!r2_account_id || !r2_access_key_id || !r2_secret_access_key || !r2_bucket_name) {
  console.warn('[R2 Config Warning] One or more R2 environment variables are missing!');
}

const s3_client = new S3Client({
  region: 'auto',
  endpoint: `https://${r2_account_id}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: r2_access_key_id || '',
    secretAccessKey: r2_secret_access_key || '',
  },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: Target and override Node inputs
function set_node_inputs(workflow, target_type, target_title, new_inputs) {
  let count = 0;
  for (const [node_id, node] of Object.entries(workflow)) {
    const matches_type = target_type ? node.class_type === target_type : true;
    const matches_title = target_title ? node._meta?.title === target_title : true;

    if (matches_type && matches_title) {
      node.inputs = { ...node.inputs, ...new_inputs };
      console.log(`[Config] Updated Node ID "${node_id}" (${node.class_type}):`, new_inputs);
      count++;
    }
  }
}

// Helper: Upload a simple text log directly to R2
async function upload_text_log_to_r2(key, text_content) {
  console.log(`[R2 Log] Sending telemetry log: ${key}...`);
  try {
    await s3_client.send(new PutObjectCommand({
      Bucket: r2_bucket_name,
      Key: key,
      Body: text_content,
      ContentType: 'text/plain',
    }));
    console.log(`[R2 Log SUCCESS] ${key} written to R2.`);
  } catch (err) {
    console.error(`[R2 Log ERROR] Failed to write ${key}:`, err.message);
  }
}

// 1. Download Test Image
async function download_test_image(url) {
  console.log(`[Setup] Downloading test image from ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);
  const buffer = await res.arrayBuffer();
  await mkdir(input_dir, { recursive: true });
  await writeFile(test_image_path, Buffer.from(buffer));
  console.log(`[Setup] Image saved to ${test_image_path}`);
}

// 2. Launch Local ComfyUI Instance
function launch_comfy_ui() {
  console.log('[ComfyUI] Launching headless process...');
  const comfy_process = spawn('python3', ['main.py', '--port', String(comfy_port), '--dont-print-server'], {
    cwd: join(process.cwd(), 'ComfyUI'),
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  comfy_process.on('error', (err) => {
    console.error('[ComfyUI] Process launch error:', err);
    process.exit(1);
  });

  return comfy_process;
}

// 3. Poll Server Status
async function wait_for_comfy_ready() {
  console.log('[ComfyUI] Waiting for API endpoint readiness...');
  const health_url = `${comfy_host}/history`;
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
}

// 4. Submit & Benchmark Execution
async function execute_workflow(payload) {
  console.log('[Workflow] Submitting JSON prompt payload...');
  const response = await fetch(`${comfy_host}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: payload }),
  });

  if (!response.ok) {
    const err_text = await response.text();
    throw new Error(`Workflow submission failed: ${response.status} - ${err_text}`);
  }

  const { prompt_id } = await response.json();
  console.log(`[Workflow] Prompt queued successfully. ID: ${prompt_id}`);

  const start_time = Date.now();

  while (true) {
    await sleep(4000);
    const history_res = await fetch(`${comfy_host}/history/${prompt_id}`);
    if (history_res.ok) {
      const history_data = await history_res.json();
      if (history_data[prompt_id]) {
        const duration = ((Date.now() - start_time) / 1000).toFixed(2);
        console.log(`\n==============================================`);
        console.log(`[BENCHMARK] Rendering complete!`);
        console.log(`[BENCHMARK] Total Duration: ${duration}s`);
        console.log(`==============================================\n`);
        return duration;
      }
    }
    const elapsed = ((Date.now() - start_time) / 1000).toFixed(0);
    console.log(`[Workflow] Processing video... Elapsed: ${elapsed}s`);
  }
}

// 5. Upload Video Result to Cloudflare R2
async function upload_to_r2(file_path) {
  console.log(`[R2] Starting streaming video upload to Cloudflare R2: ${file_path}`);
  const file_stream = createReadStream(file_path);
  const destination_key = `test-output/test_run.mp4`;

  await s3_client.send(new PutObjectCommand({
    Bucket: r2_bucket_name,
    Key: destination_key,
    Body: file_stream,
    ContentType: 'video/mp4',
  }));

  console.log(`[R2 Video SUCCESS] Asset stored at: ${destination_key}`);
}

// --- Main Pipeline ---
async function main() {
  const run_timestamp = new Date().toISOString();
  
  try {
    // -------------------------------------------------------------
    // TELEMETRY LOG #1: PRE-RENDER PROOF OF LIFE
    // -------------------------------------------------------------
    const pre_render_text = [
      `[SALAD NODE TELEMETRY - PRE-RENDER]`,
      `Status: ALIVE & RUNNING`,
      `Timestamp: ${run_timestamp}`,
      `Machine Node ID: ${process.env.salad_machine_id || 'local_test'}`,
      `Target Bucket: ${r2_bucket_name}`,
      `Starting ComfyUI boot sequence and download...`
    ].join('\n');

    await upload_text_log_to_r2('test-output/pre-render.txt', pre_render_text);

    // Step 1: Input Setup
    const image_url = process.env.test_image_url || default_test_image_url;
    await download_test_image(image_url);

    const raw_json = readFileSync(api_json_path, 'utf-8');
    const workflow = JSON.parse(raw_json);

    const fresh_seed = Math.floor(Math.random() * 1000000000000000);
    console.log(`[Setup] Assigned noise_seed: ${fresh_seed}`);

    set_node_inputs(workflow, 'LoadImage', null, { image: 'test_input.jpg' });
    set_node_inputs(workflow, 'RandomNoise', null, { noise_seed: fresh_seed });

    // Step 2: Execution
    launch_comfy_ui();
    await wait_for_comfy_ready();
    const duration = await execute_workflow(workflow);

    // Step 3: Output Handling
    await mkdir(output_dir, { recursive: true });
    const output_files = readdirSync(output_dir).filter((file) => file.endsWith('.mp4'));
    
    if (output_files.length === 0) {
      throw new Error(`[Error] No .mp4 output file found in ${output_dir}`);
    }

    const output_file = join(output_dir, output_files[output_files.length - 1]);
    console.log(`[Output] Local render file identified: ${output_file}`);

    // Step 4: Storage Migration (Video MP4)
    await upload_to_r2(output_file);

    // -------------------------------------------------------------
    // TELEMETRY LOG #2: POST-RENDER PROOF OF COMPLETION
    // -------------------------------------------------------------
    const post_render_text = [
      `[SALAD NODE TELEMETRY - POST-RENDER]`,
      `Status: SUCCESS`,
      `Completed At: ${new Date().toISOString()}`,
      `Total Render Time: ${duration}s`,
      `Seed Used: ${fresh_seed}`,
      `Video File: test-output/test_run.mp4`
    ].join('\n');

    await upload_text_log_to_r2('test-output/post-render.txt', post_render_text);

    console.log('[Runner] Test run completed successfully. Exiting.');
    process.exit(0);

  } catch (err) {
    console.error('[Fatal Error]:', err.stack || err.message);

    // Attempt to log failure directly to R2 if crash occurs
    await upload_text_log_to_r2('test-output/error-log.txt', `[CRASH ERROR]\nTimestamp: ${new Date().toISOString()}\nError: ${err.message}\nStack: ${err.stack}`);

    process.exit(1);
  }
}

main();
