import { spawn } from 'child_process';
import { readFileSync, readdirSync, createReadStream, statSync } from 'fs';
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
const NUM_VIDEOS = 3; // Generate 3 videos
const VIDEO_DURATION_SECONDS = 3; // 3 seconds each

// --- R2 Credentials (UPPERCASE) ---
const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  console.warn('[R2 Config Warning] One or more R2 environment variables are missing!');
}

const s3_client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || '',
    secretAccessKey: R2_SECRET_ACCESS_KEY || '',
  },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: Find all MP4 files recursively
function findAllMp4Files(dir) {
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findAllMp4Files(fullPath));
      } else if (entry.name.endsWith('.mp4')) {
        results.push(fullPath);
      }
    }
  } catch (err) {
    // Directory might not exist
  }
  return results;
}

// Helper: Get the latest MP4 file
function getLatestMp4File(dir) {
  const files = findAllMp4Files(dir);
  if (files.length === 0) return null;
  
  // Sort by modification time (newest first)
  files.sort((a, b) => {
    return statSync(b).mtime.getTime() - statSync(a).mtime.getTime();
  });
  
  return files[0];
}

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
  return count;
}

// Helper: Upload text file directly to bucket root
async function upload_text_log_to_r2(key, text_content) {
  console.log(`[R2 Log] Sending telemetry log: ${key}...`);
  try {
    await s3_client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: text_content,
      ContentType: 'text/plain',
    }));
    console.log(`[R2 Log SUCCESS] ${key} written to R2 bucket root.`);
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
async function execute_workflow(payload, video_number) {
  console.log(`[Workflow ${video_number}] Submitting JSON prompt payload...`);
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
  console.log(`[Workflow ${video_number}] Prompt queued successfully. ID: ${prompt_id}`);

  const start_time = Date.now();

  while (true) {
    await sleep(4000);
    const history_res = await fetch(`${comfy_host}/history/${prompt_id}`);
    if (history_res.ok) {
      const history_data = await history_res.json();
      if (history_data[prompt_id]) {
        const duration = ((Date.now() - start_time) / 1000).toFixed(2);
        console.log(`\n==============================================`);
        console.log(`[BENCHMARK ${video_number}] Rendering complete!`);
        console.log(`[BENCHMARK ${video_number}] Total Duration: ${duration}s`);
        console.log(`==============================================\n`);
        return duration;
      }
    }
    const elapsed = ((Date.now() - start_time) / 1000).toFixed(0);
    console.log(`[Workflow ${video_number}] Processing video... Elapsed: ${elapsed}s`);
  }
}

// 5. Upload Video Result directly to Cloudflare R2 Root
async function upload_to_r2(file_path, video_number) {
  const destination_key = `test_run_${video_number}.mp4`;
  console.log(`[R2] Starting streaming video upload to R2 root: ${destination_key}`);
  const file_stream = createReadStream(file_path);

  await s3_client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: destination_key,
    Body: file_stream,
    ContentType: 'video/mp4',
  }));

  console.log(`[R2 Video SUCCESS] Asset stored at: ${destination_key}`);
  return destination_key;
}

// Helper: Modify workflow for duration
function update_workflow_duration(workflow, duration_seconds, fps) {
  // Find the PrimitiveInt node for duration (ID 398:362)
  for (const [node_id, node] of Object.entries(workflow)) {
    if (node.class_type === 'PrimitiveInt' && node._meta?.title === 'Duration') {
      node.inputs.value = duration_seconds;
      console.log(`[Config] Updated Duration to ${duration_seconds} seconds`);
    }
    if (node.class_type === 'PrimitiveInt' && node._meta?.title === 'Frame Rate') {
      node.inputs.value = fps || 25;
    }
  }
  return workflow;
}

// --- Main Pipeline ---
async function main() {
  const run_timestamp = new Date().toISOString();
  const uploaded_files = [];
  
  try {
    // -------------------------------------------------------------
    // FILE 1: PRE-RENDER TEXT FILE AT BUCKET ROOT
    // -------------------------------------------------------------
    const pre_render_text = [
      `[SALAD NODE TELEMETRY - PRE-RENDER]`,
      `Status: ALIVE & RUNNING`,
      `Timestamp: ${run_timestamp}`,
      `Target Bucket: ${R2_BUCKET_NAME}`,
      `Generating ${NUM_VIDEOS} videos of ${VIDEO_DURATION_SECONDS} seconds each`,
      `Starting ComfyUI boot sequence and download...`
    ].join('\n');

    await upload_text_log_to_r2('pre-render.txt', pre_render_text);

    // Step 1: Input Setup
    const image_url = process.env.TEST_IMAGE_URL || default_test_image_url;
    await download_test_image(image_url);

    // Read the base workflow
    const raw_json = readFileSync(api_json_path, 'utf-8');
    const base_workflow = JSON.parse(raw_json);

    // Modify for shorter duration
    const workflow = update_workflow_duration(base_workflow, VIDEO_DURATION_SECONDS, 25);

    // Step 2: Ensure ComfyUI is running
    console.log('[ComfyUI] Waiting for existing instance...');
    await wait_for_comfy_ready();

    // Step 3: Generate multiple videos
    const video_results = [];
    
    for (let i = 1; i <= NUM_VIDEOS; i++) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🎬 GENERATING VIDEO ${i}/${NUM_VIDEOS}`);
      console.log(`${'='.repeat(60)}\n`);
      
      // Create a fresh copy of the workflow for each run
      const workflow_copy = JSON.parse(JSON.stringify(workflow));
      
      // Generate a fresh seed for each video
      const fresh_seed = Math.floor(Math.random() * 1000000000000000);
      console.log(`[Setup] Video ${i} assigned noise_seed: ${fresh_seed}`);
      
      // Update the workflow with the new seed
      set_node_inputs(workflow_copy, 'RandomNoise', null, { noise_seed: fresh_seed });
      
      // Update the image input
      set_node_inputs(workflow_copy, 'LoadImage', null, { image: 'test_input.jpg' });
      
      // Execute the workflow
      const duration = await execute_workflow(workflow_copy, i);
      
      // Find the output file
      const output_file = getLatestMp4File(output_dir);
      
      if (!output_file) {
        throw new Error(`[Error] No .mp4 output file found for video ${i} in ${output_dir}`);
      }
      
      console.log(`[Output ${i}] Local render file identified: ${output_file}`);
      
      // Upload to R2
      const r2_key = await upload_to_r2(output_file, i);
      uploaded_files.push(r2_key);
      
      video_results.push({
        number: i,
        seed: fresh_seed,
        duration: duration,
        file: output_file,
        r2_key: r2_key
      });
      
      console.log(`✅ Video ${i}/${NUM_VIDEOS} completed!\n`);
      
      // Clean up the output file after upload (optional)
      // Uncomment if you want to keep the output directory clean
      // unlinkSync(output_file);
    }

    // -------------------------------------------------------------
    // POST-RENDER TEXT FILE AT BUCKET ROOT
    // -------------------------------------------------------------
    const post_render_text = [
      `[SALAD NODE TELEMETRY - POST-RENDER]`,
      `Status: SUCCESS`,
      `Completed At: ${new Date().toISOString()}`,
      `Total Videos Generated: ${NUM_VIDEOS}`,
      `Video Duration: ${VIDEO_DURATION_SECONDS}s each`,
      `Uploaded Files:`,
      ...uploaded_files.map((f, i) => `  ${i+1}. ${f}`),
      `Results:`,
      ...video_results.map(r => 
        `  Video ${r.number}: seed=${r.seed}, render_time=${r.duration}s, r2_key=${r.r2_key}`
      )
    ].join('\n');

    await upload_text_log_to_r2('post-render.txt', post_render_text);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎉 ALL ${NUM_VIDEOS} VIDEOS COMPLETED SUCCESSFULLY!`);
    console.log(`${'='.repeat(60)}`);
    console.log(`\nUploaded files:`);
    uploaded_files.forEach((f, i) => console.log(`  ${i+1}. ${f}`));
    console.log(`\n[Runner] Test run completed successfully. Exiting.`);
    process.exit(0);

  } catch (err) {
    console.error('[Fatal Error]:', err.stack || err.message);

    // Write crash details directly to bucket root
    await upload_text_log_to_r2('error-log.txt', `[CRASH ERROR]\nTimestamp: ${new Date().toISOString()}\nError: ${err.message}\nStack: ${err.stack}\n\nUploaded ${uploaded_files.length} files before crash: ${uploaded_files.join(', ')}`);

    process.exit(1);
  }
}

main();
