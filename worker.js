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
const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET || '';
const CONTAINER_OUTPUT_DIR = '/workspace/output';

// Determine stable worker identity (hostname-based or env override)
function getWorkerUrl() {
    if (process.env.WORKER_URL) {
        return process.env.WORKER_URL;
    }
    const hostname = os.hostname();
    return `http://${hostname}:${PORT}`;
}

let workerUrl = getWorkerUrl();

function authHeaders() {
    const headers = {};
    if (WORKER_SHARED_SECRET) {
        headers['x-worker-token'] = WORKER_SHARED_SECRET;
    }
    return headers;
}

// ==================== CAPABILITIES ====================
function getCapabilities() {
    return {
        cpuCores: os.cpus().length,
        totalMemoryGB: Math.round(os.totalmem() / (1024 ** 3)),
        platform: os.platform(),
        dockerAvailable: checkDocker()
    };
}

function checkDocker() {
    try {
        execSync('docker --version');
        return true;
    } catch {
        return false;
    }
}

const capabilities = getCapabilities();

// ==================== HELPERS ====================
function isSafeImageRef(value) {
    return /^[a-z0-9]+([._/-][a-z0-9]+)*(?::[A-Za-z0-9._-]+)?$/i.test(value || '');
}

async function downloadFile(url, outputPath) {
    const response = await axios({ method: 'GET', url, responseType: 'stream' });

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

function runCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                return reject(err);
            }
            resolve({ stdout, stderr });
        });
    });
}

function normalizeLineEndings(filePath) {
    try {
        let content = fs.readFileSync(filePath, 'utf8');
        // Convert CRLF (Windows) to LF (Unix)
        content = content.replace(/\r\n/g, '\n');
        fs.writeFileSync(filePath, content, 'utf8');
    } catch (err) {
        console.log('⚠️ Could not normalize line endings for', path.basename(filePath));
    }
}

function createZipFromDirectory(sourceDir, zipPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip');

        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();

        output.on('close', resolve);
        archive.on('error', reject);
    });
}

// ==================== STATE ====================
let isExecuting = false;
let registered = false;

// ==================== REGISTER ====================
async function registerWorker() {
    try {
        const payload = { workerUrl, capabilities };
        if (WORKER_SHARED_SECRET) {
            payload.workerToken = WORKER_SHARED_SECRET;
        }
        await axios.post(`${SERVER_URL}/register`, payload, { headers: authHeaders() });
        console.log('✅ Registered:', workerUrl);

        registered = true;

        // Start polling for jobs
        setInterval(pollForJob, 3000);
        
        // Start heartbeat loop (every 5 seconds)
        setInterval(sendHeartbeat, 5000);
    } catch (err) {
        console.log('❌ Register failed, retrying...');
        setTimeout(registerWorker, 3000);
    }
}

// ==================== HEARTBEAT ====================
async function sendHeartbeat() {
    if (!registered) return;

    try {
        const payload = { workerUrl };
        if (WORKER_SHARED_SECRET) {
            payload.workerToken = WORKER_SHARED_SECRET;
        }
        await axios.post(`${SERVER_URL}/heartbeat`, payload, { headers: authHeaders() });
    } catch (err) {
        console.log('⚠️ Heartbeat failed:', err.message);
    }
}

// ==================== POLL ====================
async function pollForJob() {
    if (!registered || isExecuting) return;

    try {
        const payload = { workerUrl };
        if (WORKER_SHARED_SECRET) {
            payload.workerToken = WORKER_SHARED_SECRET;
        }
        const res = await axios.post(`${SERVER_URL}/poll-job`, payload, { headers: authHeaders() });
        const job = res.data.job;

        if (job) {
            handleJob(job);
        }
    } catch (err) {
        console.log('⚠️ Poll failed:', err.message);
    }
}

// ==================== JOB EXECUTION ====================
async function handleJob(job) {
    const { jobId, mode, image, files, serverUrl } = job;
    const SERVER = serverUrl || SERVER_URL;

    if (isExecuting) return;
    isExecuting = true;

    console.log(`🚀 Job: ${jobId} | Mode: ${mode}`);

    try {
        const updatePayload = {
            jobId,
            status: 'running',
            workerUrl
        };
        if (WORKER_SHARED_SECRET) {
            updatePayload.workerToken = WORKER_SHARED_SECRET;
        }
        await axios.post(`${SERVER}/job-update`, updatePayload, { headers: authHeaders() });

        const jobsPath = path.join(__dirname, 'jobs');

        // 🔥 CLEAN JOB FOLDER
        fs.rmSync(jobsPath, { recursive: true, force: true });
        fs.mkdirSync(jobsPath);

        const outputDir = path.join(jobsPath, 'output');
        fs.mkdirSync(outputDir, { recursive: true });

        let stdout = '';
        let stderr = '';

        // ================= DOCKER IMAGE =================
        if (mode === 'docker-image') {
            await runCommand(`docker pull ${image}`);
            const result = await runCommand(
                `docker run --platform linux/amd64 --rm -v "${outputDir}:${CONTAINER_OUTPUT_DIR}" ${image}`
            );
            stdout = result.stdout;
            stderr = result.stderr;
        }

        // ================= BUILD + RUN =================
        else if (mode === 'build-and-run') {
            if (!files || files.length === 0) throw new Error('No files');

            let entryFile = 'main.py';

            for (const file of files) {
                const cleanPath = file.replace(/\\/g, '/');

                const fileName = cleanPath.startsWith('http')
                    ? path.basename(new URL(cleanPath).pathname)
                    : path.basename(cleanPath);

                if (fileName.endsWith('.py')) entryFile = fileName;

                const localPath = path.join(jobsPath, fileName);

                const fileUrl = cleanPath.startsWith('http')
                    ? cleanPath
                    : `${SERVER}/${cleanPath}`;

                console.log("⬇️", fileUrl);
                await downloadFile(fileUrl, localPath);
            }

            // 🔥 Dynamic Dockerfile
            const dockerfile = `
FROM python:3.10
WORKDIR /app
COPY . .
RUN pip install pandas numpy
CMD ["python", "${entryFile}"]
`;

            fs.writeFileSync(path.join(jobsPath, 'Dockerfile'), dockerfile);

            const imageName = `job-${jobId}`;

            await runCommand(`docker build -t ${imageName} ${jobsPath}`);

            const result = await runCommand(
                `docker run --rm -v "${outputDir}:${CONTAINER_OUTPUT_DIR}" ${imageName}`
            );

            stdout = result.stdout;
            stderr = result.stderr;

            exec(`docker rmi ${imageName}`, () => {});
        }

        // ================= PYTHON FILES =================
        else if (mode === 'python-files') {
            if (!files || files.length === 0) throw new Error('No files provided');

            let entryFile = 'main.py';
            const downloadedFiles = [];

            // Download all provided files
            for (const file of files) {
                const cleanPath = file.replace(/\\/g, '/');

                const fileName = cleanPath.startsWith('http')
                    ? path.basename(new URL(cleanPath).pathname)
                    : path.basename(cleanPath);

                if (fileName.endsWith('.py')) entryFile = fileName;

                const localPath = path.join(jobsPath, fileName);
                downloadedFiles.push(fileName);

                const fileUrl = cleanPath.startsWith('http')
                    ? cleanPath
                    : `${SERVER}/${cleanPath}`;

                console.log('⬇️', fileUrl);
                await downloadFile(fileUrl, localPath);
                
                // Normalize line endings (CRLF → LF) for Python files
                if (fileName.endsWith('.py')) {
                    normalizeLineEndings(localPath);
                    console.log('📝 Normalized line endings:', fileName);
                }
            }

            // Create Dockerfile for Python environment with explicit platform
            const dockerfile = `
FROM --platform=linux/amd64 python:3.10
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir pandas numpy scikit-learn matplotlib
CMD ["python", "${entryFile}"]
`;

            fs.writeFileSync(path.join(jobsPath, 'Dockerfile'), dockerfile);

            const imageName = `python-job-${jobId}`;

            console.log('🔨 Building Python job image (linux/amd64)...');
            await runCommand(`docker build --platform linux/amd64 -t ${imageName} ${jobsPath}`);

            console.log('▶️ Running Python job...');
            const result = await runCommand(
                `docker run --platform linux/amd64 --rm -v "${outputDir}:${CONTAINER_OUTPUT_DIR}" ${imageName}`
            );

            stdout = result.stdout;
            stderr = result.stderr;

            // Clean up image
            exec(`docker rmi ${imageName}`, () => {});
        }

        else {
            throw new Error('Unsupported mode');
        }

        // ================= SAVE OUTPUT =================
        fs.writeFileSync(
            path.join(outputDir, 'logs.txt'),
            `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`
        );

        const zipPath = path.join(jobsPath, `${jobId}.zip`);
        await createZipFromDirectory(outputDir, zipPath);

        console.log('✅ Job completed, uploading artifacts...');

        // Upload output artifacts to server
        let outputFileUrl = null;
        try {
            const form = new FormData();
            form.append('file', fs.createReadStream(zipPath));
            form.append('task_id', jobId);
            form.append('workerUrl', workerUrl);
            
            const uploadPayload = { workerToken: WORKER_SHARED_SECRET || undefined };
            const uploadRes = await axios.post(
                `${SERVER}/upload-output`,
                form,
                {
                    headers: {
                        ...form.getHeaders(),
                        ...authHeaders()
                    }
                }
            );
            outputFileUrl = uploadRes.data.output_file_url;
            console.log('📤 Artifacts uploaded:', outputFileUrl);
        } catch (uploadErr) {
            console.log('⚠️ Artifact upload failed:', uploadErr.message);
        }

        const completedPayload = {
            jobId,
            status: 'completed',
            result: stdout,
            workerUrl
        };
        if (outputFileUrl) {
            completedPayload.output_file_url = outputFileUrl;
        }
        if (WORKER_SHARED_SECRET) {
            completedPayload.workerToken = WORKER_SHARED_SECRET;
        }
        await axios.post(`${SERVER}/job-update`, completedPayload, { headers: authHeaders() });

    } catch (err) {
        console.log('❌ Error:', err.message);

        // Categorize error to help server decide on retry strategy
        let errorCategory = 'execution_error';
        if (err.message.includes('exec format error') || err.message.includes('line endings') || err.message.includes('platform')) {
            errorCategory = 'architecture_mismatch';
        } else if (err.message.includes('No such file') || err.message.includes('not found')) {
            errorCategory = 'missing_dependency';
        } else if (err.message.includes('timeout') || err.message.includes('timed out')) {
            errorCategory = 'timeout';
        }

        const failedPayload = {
            jobId,
            status: 'failed',
            error: err.message,
            errorCategory,
            workerUrl
        };
        if (WORKER_SHARED_SECRET) {
            failedPayload.workerToken = WORKER_SHARED_SECRET;
        }
        await axios.post(`${SERVER}/job-update`, failedPayload, { headers: authHeaders() });
    }

    isExecuting = false;
}

// ==================== START ====================
app.listen(PORT, () => {
    console.log(`🚀 Worker running at ${workerUrl}`);
    console.log(`   Capabilities: ${JSON.stringify(capabilities)}`);
    if (WORKER_SHARED_SECRET) {
        console.log('🔐 Worker auth enabled');
    }
    registerWorker();
});