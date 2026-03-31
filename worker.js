require('dotenv').config();
const express = require('express');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const path = require('path');
const axios = require('axios');
const os = require('os');
const archiver = require('archiver');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.WORKER_PORT) || 4000;
const SERVER_URL = process.env.SERVER_URL || 'https://tp-00zg.onrender.com';
const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN || null;
const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET || '';
const CONTAINER_OUTPUT_DIR = '/workspace/output';

let workerUrl = process.env.WORKER_URL || null;

function authHeaders() {
    if (!WORKER_SHARED_SECRET) return {};
    return { 'x-worker-token': WORKER_SHARED_SECRET };
}

// ==================== SYSTEM CAPABILITIES ====================
function getCapabilities() {
    const caps = {
        cpuCores: os.cpus().length,
        cpuModel: os.cpus()[0]?.model || 'Unknown',
        totalMemoryGB: Math.round(os.totalmem() / (1024 ** 3)),
        freeMemoryGB: Math.round(os.freemem() / (1024 ** 3)),
        platform: os.platform(),
        hostname: os.hostname(),
        gpuAvailable: false,
        gpuModel: null,
        dockerAvailable: false
    };

    try {
        const gpu = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
            encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
        });
        caps.gpuAvailable = true;
        caps.gpuModel = gpu.trim();
    } catch {}

    try {
        execSync('docker --version', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
        caps.dockerAvailable = true;
    } catch {}

    return caps;
}

const capabilities = getCapabilities();
console.log('🖥️ Capabilities:', JSON.stringify(capabilities, null, 2));

function isSafeImageRef(value) {
    if (!value || typeof value !== 'string') return false;
    if (/\s/.test(value)) return false;
    return /^[a-z0-9]+([._/-][a-z0-9]+)*(?::[A-Za-z0-9._-]+)?$/i.test(value.trim());
}

function parseResourceLimits(resources = {}) {
    const requestedCpu = Number(resources?.cpu);
    const requestedRam = Number(resources?.ram);

    const cpuLimit = Number.isFinite(requestedCpu) && requestedCpu > 0
        ? Math.min(requestedCpu, capabilities.cpuCores)
        : Math.max(1, Math.floor(capabilities.cpuCores / 2));

    const ramLimitGb = Number.isFinite(requestedRam) && requestedRam > 0
        ? requestedRam
        : Math.max(1, Math.floor(capabilities.totalMemoryGB / 3));

    return { cpuLimit, ramLimitGb };
}

function hasEnoughFreeMemory(resources = {}) {
    const { ramLimitGb } = parseResourceLimits(resources);
    const freeMemoryGb = os.freemem() / (1024 ** 3);
    const safetyBufferGb = 0.75;
    return freeMemoryGb >= (ramLimitGb + safetyBufferGb);
}

async function downloadFile(url, outputPath) {
    const response = await axios({
        method: 'GET',
        url,
        responseType: 'stream'
    });

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// ==================== STATE ====================
let isExecuting = false;
let registered = false;
let activeJobOffer = null;

// ==================== REGISTRATION ====================
async function registerWorker() {
    if (!workerUrl) {
        console.warn('⚠️ Waiting for worker URL...');
        setTimeout(registerWorker, 3000);
        return;
    }

    try {
        const res = await axios.post(
            `${SERVER_URL}/register`,
            { workerUrl, capabilities, workerToken: WORKER_SHARED_SECRET || undefined },
            { headers: authHeaders() }
        );
        console.log('✅ Registered | Trust:', res.data.trustScore);

        registered = true;

        setInterval(sendHeartbeat, 10000);
        setInterval(pollForJob, 5000);
        setTimeout(pollForJob, 1000);

    } catch (err) {
        console.error('❌ Registration failed:', err.message);
        setTimeout(registerWorker, 5000);
    }
}

async function sendHeartbeat() {
    try {
        await axios.post(
            `${SERVER_URL}/heartbeat`,
            { workerUrl, workerToken: WORKER_SHARED_SECRET || undefined },
            { headers: authHeaders() }
        );
    } catch {}
}

// ==================== POLL ====================
async function pollForJob() {
    if (!registered || isExecuting || activeJobOffer || !workerUrl) return;

    try {
        const res = await axios.post(
            `${SERVER_URL}/poll-job`,
            { workerUrl, workerToken: WORKER_SHARED_SECRET || undefined },
            { headers: authHeaders() }
        );
        const { job } = res.data;

        if (job) {
            if (!hasEnoughFreeMemory(job.resources_required)) {
                const targetServer = job.serverUrl || SERVER_URL;
                const { ramLimitGb } = parseResourceLimits(job.resources_required);
                const freeMemoryGb = (os.freemem() / (1024 ** 3)).toFixed(2);
                const reason = `Skipped: low free memory (${freeMemoryGb} GB free, requires >= ${ramLimitGb + 0.75} GB)`;
                console.warn(`⚠️ ${reason}`);
                await axios.post(
                    `${targetServer}/job-update`,
                    {
                        jobId: job.jobId,
                        status: 'rejected',
                        error: reason,
                        workerUrl,
                        workerToken: WORKER_SHARED_SECRET || undefined
                    },
                    { headers: authHeaders() }
                );
                return;
            }

            console.log(`📋 Job received: ${job.jobId}`);
            handleJob(job);
        }
    } catch (err) {}
}

function runCommand(command, options = {}) {
    return new Promise((resolve, reject) => {
        exec(command, { maxBuffer: 20 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                return reject(err);
            }
            resolve({ stdout, stderr });
        });
    });
}

function listFilesRecursive(rootDir) {
    if (!fs.existsSync(rootDir)) return [];
    const results = [];

    function walk(currentDir) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else {
                const rel = path.relative(rootDir, fullPath).replace(/\\/g, '/');
                results.push(rel);
            }
        }
    }

    walk(rootDir);
    return results;
}

function createZipFromDirectory(sourceDir, zipPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);

        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();
    });
}

async function uploadOutputZip(serverUrl, jobId, zipPath) {
    const form = new FormData();
    form.append('task_id', jobId);
    form.append('workerUrl', workerUrl || '');
    if (WORKER_SHARED_SECRET) {
        form.append('workerToken', WORKER_SHARED_SECRET);
    }
    form.append('file', fs.createReadStream(zipPath), 'output.zip');

    const response = await axios.post(`${serverUrl}/upload-output`, form, {
        headers: { ...form.getHeaders(), ...authHeaders() },
        timeout: 120000
    });

    return response.data;
}

async function runJobInDocker(image, outputDir, resourcesRequired = {}) {
    const { cpuLimit, ramLimitGb } = parseResourceLimits(resourcesRequired);
    const memoryArg = `${ramLimitGb}g`;
    const dockerCommand = [
        'docker run --rm',
        `--memory ${memoryArg}`,
        `--memory-swap ${memoryArg}`,
        `--cpus ${cpuLimit}`,
        '--pids-limit 256',
        `-v "${outputDir}:${CONTAINER_OUTPUT_DIR}"`,
        `-e OUTPUT_DIR=${CONTAINER_OUTPUT_DIR}`,
        image
    ].join(' ');

    return runCommand(dockerCommand, { timeout: 600000 });
}

async function runLocalFallback(job, jobsPath, outputDir) {
    if (isSafeImageRef(job?.image) && capabilities.dockerAvailable) {
        try {
            console.log('🔁 Fallback: retrying docker run with relaxed limits...');
            return await runCommand(
                `docker run --rm -v "${outputDir}:${CONTAINER_OUTPUT_DIR}" -e OUTPUT_DIR=${CONTAINER_OUTPUT_DIR} ${job.image}`,
                { timeout: 600000 }
            );
        } catch (relaxedDockerErr) {
            console.warn(`⚠️ Relaxed docker fallback failed: ${relaxedDockerErr.message}`);
        }
    }

    const files = Array.isArray(job?.files) ? job.files : [];
    if (files.length === 0) {
        throw new Error('Docker failed and no downloadable script files were provided for local fallback execution');
    }

    let mainFile = '';
    const downloadedFiles = [];
    for (const file of files) {
        const cleanPath = file.replace(/\\/g, '/');
        let fileName = path.basename(new URL(cleanPath).pathname);

        if (fileName.endsWith('.py') && !mainFile) {
            fileName = 'main.py';
            mainFile = fileName;
        } else if (fileName.endsWith('.csv')) {
            fileName = 'data.csv';
        }

        const localPath = path.join(jobsPath, fileName);
        await downloadFile(cleanPath, localPath);
        downloadedFiles.push(fileName);
    }

    if (!mainFile) {
        throw new Error('Local fallback failed: no Python entry file found');
    }

    const result = await runCommand(`py "${path.join(jobsPath, mainFile)}"`, {
        cwd: jobsPath,
        timeout: 180000,
        env: { ...process.env, OUTPUT_DIR: outputDir }
    });

    for (const f of downloadedFiles) {
        const fp = path.join(jobsPath, f);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }

    return result;
}

// ==================== JOB ====================
async function handleJob(job) {
    const { jobId, image, serverUrl, mode, resources_required } = job;
    const SERVER = serverUrl || SERVER_URL;

    if (isExecuting) return;
    isExecuting = true;

    console.log(`🚀 Executing job: ${jobId}`);

    try {
        await axios.post(
            `${SERVER}/job-update`,
            { jobId, status: 'running', workerUrl, workerToken: WORKER_SHARED_SECRET || undefined },
            { headers: authHeaders() }
        );

        const jobsPath = path.join(__dirname, 'jobs');
        if (!fs.existsSync(jobsPath)) fs.mkdirSync(jobsPath);

        const outputDir = path.join(jobsPath, 'output', jobId);
        fs.rmSync(outputDir, { recursive: true, force: true });
        fs.mkdirSync(outputDir, { recursive: true });

        let stdout = '';
        let stderr = '';
        if (mode === 'docker-image') {
            if (!isSafeImageRef(image)) {
                throw new Error('Docker image reference is required for docker-image mode');
            }
            if (!capabilities.dockerAvailable) {
                throw new Error('Worker cannot run docker-image job because Docker is unavailable');
            }

            try {
                console.log(`🐳 Pulling image: ${image}`);
                await runCommand(`docker pull ${image}`, { timeout: 300000 });

                console.log('🐳 Running container job with resource limits...');
                const dockerRun = await runJobInDocker(image, outputDir, resources_required);
                stdout = dockerRun.stdout || '';
                stderr = dockerRun.stderr || '';
            } catch (dockerErr) {
                console.warn(`⚠️ Docker execution failed, attempting local fallback: ${dockerErr.message}`);
                const localRun = await runLocalFallback(job, jobsPath, outputDir);
                stdout = localRun.stdout || '';
                stderr = [dockerErr.stderr || dockerErr.message || '', localRun.stderr || ''].filter(Boolean).join('\n');
            }
        } else if (mode === 'python-files') {
            console.log('📦 Running uploaded file job (python-files mode)...');
            const localRun = await runLocalFallback(job, jobsPath, outputDir);
            stdout = localRun.stdout || '';
            stderr = localRun.stderr || '';
        } else {
            throw new Error(`Unsupported job mode: ${mode}`);
        }

        const logsPath = path.join(outputDir, 'logs.txt');
        fs.writeFileSync(
            logsPath,
            ['=== STDOUT ===', stdout, '', '=== STDERR ===', stderr].join('\n'),
            'utf8'
        );

        const outputFiles = listFilesRecursive(outputDir);
        const modelExts = new Set(['.pt', '.pth', '.pkl', '.h5', '.joblib', '.onnx']);
        const modelFiles = outputFiles.filter((f) => modelExts.has(path.extname(f).toLowerCase()));
        let outputWarning = modelFiles.length === 0 ? 'No model file generated' : null;

        const zipPath = path.join(jobsPath, `${jobId}-output.zip`);
        await createZipFromDirectory(outputDir, zipPath);
        let outputFileUrl = null;

        try {
            const uploadRes = await uploadOutputZip(SERVER, jobId, zipPath);
            outputFileUrl = uploadRes.output_file_url || null;
        } catch (uploadErr) {
            const uploadWarning = `Output upload failed: ${uploadErr.message || String(uploadErr)}`;
            outputWarning = outputWarning ? `${outputWarning}; ${uploadWarning}` : uploadWarning;
            console.warn(`⚠️ ${uploadWarning}`);
        }

        console.log('✅ Job done');

        await axios.post(
            `${SERVER}/job-update`,
            {
                jobId,
                status: 'completed',
                result: stdout,
                output_file_url: outputFileUrl,
                output_warning: outputWarning,
                output_files: outputFiles,
                workerUrl,
                workerToken: WORKER_SHARED_SECRET || undefined
            },
            { headers: authHeaders() }
        );

        if (fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
        }
        fs.rmSync(outputDir, { recursive: true, force: true });

        isExecuting = false;

    } catch (err) {
        console.error('🔥 Job failed:', err.message);

        await axios.post(
            `${SERVER}/job-update`,
            {
                jobId,
                status: 'failed',
                error: err.stderr || err.message,
                workerUrl,
                workerToken: WORKER_SHARED_SECRET || undefined
            },
            { headers: authHeaders() }
        );

        isExecuting = false;
    }
}

// ==================== START ====================
app.listen(PORT, async () => {
    console.log(`🚀 Worker running on port ${PORT}`);

    if (NGROK_AUTHTOKEN) {
        try {
            const ngrok = require('@ngrok/ngrok');
            const listener = await ngrok.forward({
                addr: PORT,
                authtoken: NGROK_AUTHTOKEN
            });

            workerUrl = listener.url();
            console.log('🌍 Public URL:', workerUrl);
        } catch (err) {
            workerUrl = process.env.WORKER_URL || `http://${os.hostname()}:${PORT}`;
            console.warn(`⚠️ ngrok unavailable (${err.message}). Falling back to worker id: ${workerUrl}`);
        }
    } else {
        workerUrl = process.env.WORKER_URL || `http://${os.hostname()}:${PORT}`;
    }

    registerWorker();
});