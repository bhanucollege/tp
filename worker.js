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
        const originalLength = content.length;
        
        // Convert CRLF (Windows) to LF (Unix)
        content = content.replace(/\r\n/g, '\n');
        
        // Write as Buffer to ensure no OS-level line ending conversion on Windows
        fs.writeFileSync(filePath, Buffer.from(content, 'utf8'));
        
        const newLength = content.length;
        if (newLength !== originalLength) {
            console.log(`   📝 Line endings fixed for ${path.basename(filePath)} (${originalLength} → ${newLength} bytes)`);
        }
    } catch (err) {
        console.log('⚠️ Could not normalize line endings for', path.basename(filePath), err.message);
    }
}

function fixCsvPathsInPython(jobsPath, csvFiles) {
    try {
        const pyFiles = fs.readdirSync(jobsPath).filter(f => f.endsWith('.py'));
        let totalFixed = 0;
        
        for (const pyFile of pyFiles) {
            const filePath = path.join(jobsPath, pyFile);
            let content = fs.readFileSync(filePath, 'utf8');
            const originalContent = content;
            
            // Simple string replacements for common CSV patterns
            for (const csvFileName of csvFiles) {
                const baseName = path.basename(csvFileName);
                
                // Extract the original filename (remove timestamp prefix if present)
                // Server uploads files with timestamp: 1774930392589-data.csv
                // But Python code refers to original: 'data.csv'
                // So we need to replace both the timestamped and original filenames
                const timestampMatch = baseName.match(/^\d+-(.+)$/);
                const originalName = timestampMatch ? timestampMatch[1] : baseName;
                
                // Escape special regex characters in filenames
                const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const escapedOrig = originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                
                // Replace timestamps filename versions: '1774930392589-data.csv' -> '/app/1774930392589-data.csv'
                content = content.replace(new RegExp(`'${escapedBase}'`, 'g'), `'/app/${baseName}'`);
                content = content.replace(new RegExp(`"${escapedBase}"`, 'g'), `"/app/${baseName}"`);
                content = content.replace(new RegExp(`'\\.\/${escapedBase}'`, 'g'), `'/app/${baseName}'`);
                content = content.replace(new RegExp(`"\\.\\/${escapedBase}"`, 'g'), `"/app/${baseName}"`);
                
                // Replace original filename versions: 'data.csv' -> '/app/1774930392589-data.csv'
                // (map original names to timestamped names so Python can find them)
                if (originalName !== baseName) {
                    content = content.replace(new RegExp(`'${escapedOrig}'`, 'g'), `'/app/${baseName}'`);
                    content = content.replace(new RegExp(`"${escapedOrig}"`, 'g'), `"/app/${baseName}"`);
                    content = content.replace(new RegExp(`'\\.\/${escapedOrig}'`, 'g'), `'/app/${baseName}'`);
                    content = content.replace(new RegExp(`"\\.\\/${escapedOrig}"`, 'g'), `"/app/${baseName}"`);
                }
            }
            
            // Only write if changed
            if (content !== originalContent) {
                fs.writeFileSync(filePath, content, 'utf8');
                console.log(`📝 Fixed CSV paths in ${pyFile} (mapped original filenames to timestamped versions)`);
                totalFixed++;
            }
        }
        
        if (totalFixed > 0) {
            console.log(`✅ Fixed CSV paths in ${totalFixed} file(s)`);
        } else {
            console.log('ℹ️ No CSV paths needed fixing');
        }
    } catch (err) {
        console.error('❌ CSV path fixing failed:', err.stack || err.message);
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
let pollInterval = null;
let heartbeatInterval = null;

// ==================== REGISTER ====================
async function registerWorker() {
    try {
        console.log(`📤 Registering with server: ${SERVER_URL}/register`);
        const payload = { workerUrl, capabilities };
        if (WORKER_SHARED_SECRET) {
            payload.workerToken = WORKER_SHARED_SECRET;
        }
        const response = await axios.post(`${SERVER_URL}/register`, payload, { headers: authHeaders() });
        console.log('✅ Registered:', workerUrl);
        console.log('   Response:', response.status, response.data);

        registered = true;

        // Start polling for jobs (only once)
        if (!pollInterval) {
            pollInterval = setInterval(pollForJob, 3000);
        }
        
        // Start heartbeat loop (only once, every 5 seconds)
        if (!heartbeatInterval) {
            heartbeatInterval = setInterval(sendHeartbeat, 5000);
        }
    } catch (err) {
        console.error('❌ Register failed:');
        if (err.response) {
            console.error('   Status:', err.response.status);
            console.error('   Data:', err.response.data);
        } else {
            console.error('   Error:', err.message);
        }
        console.log('   Retrying in 3 seconds...');
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
        const status = err.response?.status || 'unknown';
        const errorMsg = err.response?.data?.error || err.message;
        console.log(`⚠️ Poll failed (${status}):`, errorMsg);
        if (status === 404) {
            console.log(`   Worker URL: ${workerUrl} not registered - attempting to re-register...`);
            registered = false;
            registerWorker();
        }
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

            await runCommand(
                `docker run --platform linux/amd64 --rm -v "${outputDir}:${CONTAINER_OUTPUT_DIR}" ${imageName}`
            );

            const result = await runCommand(
                `docker run --rm -v "${outputDir}:${CONTAINER_OUTPUT_DIR}" ${imageName}`
            );

            stdout = result.stdout;
            stderr = result.stderr;

            exec(`docker rmi ${imageName}`, () => {});
        }

        // ================= PYTHON FILES =================
        else if (mode === 'python-files' || mode === 'build-and-run') {
            if (!files || files.length === 0) throw new Error('No files provided');

            let entryFile = 'main.py';
            const downloadedFiles = [];
            const csvFiles = [];

            // Download all provided files
            for (const file of files) {
                const cleanPath = file.replace(/\\/g, '/');

                const fileName = cleanPath.startsWith('http')
                    ? path.basename(new URL(cleanPath).pathname)
                    : path.basename(cleanPath);

                if (fileName.endsWith('.py')) entryFile = fileName;
                if (fileName.endsWith('.csv')) csvFiles.push(fileName);

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
            
            // Fix CSV paths in Python files to use /app/filename.csv
            if (csvFiles.length > 0) {
                fixCsvPathsInPython(jobsPath, csvFiles);
            }

            // CRITICAL: Re-normalize ALL Python files after modifications to ensure LF line endings
            // (fixCsvPathsInPython may have reintroduced CRLF on Windows)
            console.log('🔧 Ensuring all Python files have Unix line endings...');
            const allPyFiles = fs.readdirSync(jobsPath).filter(f => f.endsWith('.py'));
            for (const pyFile of allPyFiles) {
                const pyPath = path.join(jobsPath, pyFile);
                normalizeLineEndings(pyPath);
                
                // Debug: check the first few bytes to verify line endings
                try {
                    const content = fs.readFileSync(pyPath, 'utf8');
                    const hasCRLF = content.includes('\r\n');
                    const hasLF = content.includes('\n');
                    console.log(`   ${pyFile}: LF=${hasLF}, CRLF=${hasCRLF}, size=${content.length} bytes`);
                } catch (e) {}
            }
            console.log('✅ Line ending normalization complete');

            // Check if requirements.txt exists
            const requirementsPath = path.join(jobsPath, 'requirements.txt');
            const hasRequirements = fs.existsSync(requirementsPath);

            // Create Dockerfile for Python environment with explicit platform
            let pipInstallCmd = '';
            if (hasRequirements) {
                console.log('📦 requirements.txt found, using it for dependencies');
                pipInstallCmd = 'RUN pip install --no-cache-dir -r requirements.txt';
            } else {
                console.log('⚠️ No requirements.txt found, installing common ML packages');
                pipInstallCmd = 'RUN pip install --no-cache-dir pandas numpy scikit-learn matplotlib tensorflow';
            }

            // Ensure entryFile is just a filename, no path separators
            const cleanEntryFile = path.basename(entryFile).replace(/\\/g, '/');
            console.log(`📄 Entry file: ${cleanEntryFile}`);

            let dockerfile = `FROM --platform=linux/amd64 python:3.10\nWORKDIR /app\nCOPY . .\n${pipInstallCmd}\nCMD ["python", "${cleanEntryFile}"]\n`;
            
            const dockerfilePath = path.join(jobsPath, 'Dockerfile');
            fs.writeFileSync(dockerfilePath, dockerfile, 'utf8');
            
            // Normalize the Dockerfile itself to ensure LF
            normalizeLineEndings(dockerfilePath);

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
            const supportedModes = ['docker-image', 'python-files', 'build-and-run'];
            throw new Error(`❌ Unsupported job mode: '${mode}'. This worker supports: ${supportedModes.join(', ')}`);
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
    console.log(`   Server URL: ${SERVER_URL}`);
    if (WORKER_SHARED_SECRET) {
        console.log('🔐 Worker auth enabled');
    } else {
        console.log('⚠️ Worker auth DISABLED (no WORKER_SHARED_SECRET)');
    }
    registerWorker();
});
