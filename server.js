require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const cors = require('cors');

// ==================== CLOUDINARY SETUP (Optional) ====================
let cloudinary = null;
let cloudinaryConfigured = false;
try {
    cloudinary = require('cloudinary').v2;

    // Support either explicit credentials or CLOUDINARY_URL in env.
    let cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    let apiKey = process.env.CLOUDINARY_API_KEY;
    let apiSecret = process.env.CLOUDINARY_API_SECRET;

    if ((!cloudName || !apiKey || !apiSecret) && process.env.CLOUDINARY_URL) {
        try {
            const parsed = new URL(process.env.CLOUDINARY_URL);
            cloudName = cloudName || parsed.pathname.replace(/^\//, '');
            apiKey = apiKey || decodeURIComponent(parsed.username || '');
            apiSecret = apiSecret || decodeURIComponent(parsed.password || '');
        } catch (parseErr) {
            console.warn('⚠️ CLOUDINARY_URL could not be parsed:', parseErr.message);
        }
    }

    cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret
    });

    const cfg = cloudinary.config();
    if (cfg?.cloud_name && cfg?.api_key && cfg?.api_secret) {
        cloudinaryConfigured = true;
        console.log(`☁️ Cloudinary configured: ${cloudinary.config().cloud_name}`);
    } else {
        cloudinary = null; // Not configured
        console.log('📦 Cloudinary credentials not set, using fallback disk storage');
    }
} catch (err) {
    console.log('📦 Cloudinary not installed, using fallback disk storage');
    cloudinary = null;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = Number(process.env.PORT) || 3000;
const JOB_MAX_RUNTIME_MS = Number(process.env.JOB_MAX_RUNTIME_MS || 15 * 60 * 1000);
const MAX_ARTIFACT_SIZE_MB = Number(process.env.MAX_ARTIFACT_SIZE_MB || 50);
const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET || '';
const DEFAULT_SERVER_URL = process.env.CENTRAL_SERVER_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// ==================== CORS & MIDDLEWARE ====================
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
const outputsDir = path.join(__dirname, 'outputs');
if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir);
app.use('/outputs', express.static(outputsDir));

// ==================== DATA STORES ====================
const workers = new Map();
const jobs = new Map();
const jobQueue = [];

const rateWindows = new Map();

function logEvent(event, payload = {}) {
    const entry = {
        ts: new Date().toISOString(),
        event,
        ...payload
    };
    console.log(JSON.stringify(entry));
}

function getRequestIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (Array.isArray(xf)) return xf[0];
    if (typeof xf === 'string') return xf.split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getRateKey(req, scope = 'ip') {
    if (scope === 'user') {
        const userId = req.headers['x-user-id'];
        return userId ? `user:${String(userId)}` : `ip:${getRequestIp(req)}`;
    }
    if (scope === 'worker') {
        const workerUrl = req.body?.workerUrl;
        return workerUrl ? `worker:${String(workerUrl)}` : `ip:${getRequestIp(req)}`;
    }
    return `ip:${getRequestIp(req)}`;
}

function createRateLimiter({ bucket, windowMs, max, scope = 'ip' }) {
    return (req, res, next) => {
        const now = Date.now();
        const key = `${bucket}:${getRateKey(req, scope)}`;
        const state = rateWindows.get(key) || { count: 0, resetAt: now + windowMs };

        if (now > state.resetAt) {
            state.count = 0;
            state.resetAt = now + windowMs;
        }

        state.count += 1;
        rateWindows.set(key, state);

        if (state.count > max) {
            const retryAfterSec = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
            res.set('Retry-After', String(retryAfterSec));
            logEvent('rate_limited', { bucket, key, path: req.path, method: req.method });
            return res.status(429).json({ error: 'Rate limit exceeded' });
        }

        next();
    };
}

function requireWorkerAuth(req, res, next) {
    if (!WORKER_SHARED_SECRET) {
        return next();
    }
    const token = req.headers['x-worker-token'] || req.body?.workerToken;
    if (!token || token !== WORKER_SHARED_SECRET) {
        logEvent('worker_auth_failed', { path: req.path, ip: getRequestIp(req) });
        return res.status(401).json({ error: 'Unauthorized worker' });
    }
    next();
}

function markJobFailed(job, reason) {
    const worker = workers.get(job.assignedWorker);
    job.status = 'failed';
    job.completedAt = Date.now();
    job.error = reason;
    if (worker) {
        worker.jobsFailed++;
        worker.trustScore = Math.max(0, worker.trustScore - 10);
        worker.currentJob = null;
    }
    logEvent('job_failed', {
        jobId: job.id,
        workerUrl: job.assignedWorker,
        reason
    });
}

function isSafeImageRef(value) {
    if (!value || typeof value !== 'string') return false;
    if (/\s/.test(value)) return false;
    return /^[a-z0-9]+([._/-][a-z0-9]+)*(?::[A-Za-z0-9._-]+)?$/i.test(value.trim());
}

// ==================== FILE UPLOAD ====================
const localDiskStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = cloudinary
    ? multer({ storage: multer.memoryStorage() })
    : multer({ storage: localDiskStorage });

const outputStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, outputsDir),
    filename: (req, file, cb) => {
        const taskId = req.body.task_id || 'task';
        const safeTaskId = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '_');
        cb(null, `${Date.now()}-${safeTaskId}-output.zip`);
    }
});
const outputUpload = multer({
    storage: outputStorage,
    limits: { fileSize: MAX_ARTIFACT_SIZE_MB * 1024 * 1024 }
});

function uploadBufferToCloudinary(file) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                resource_type: 'auto',
                folder: process.env.CLOUDINARY_FOLDER || undefined,
                use_filename: true,
                unique_filename: true
            },
            (err, result) => {
                if (err) return reject(err);
                resolve(result);
            }
        );

        uploadStream.end(file.buffer);
    });
}

app.post('/upload', upload.array('files'), async (req, res) => {
    return res.status(410).json({
        error: 'File uploads are disabled. Submit docker-image jobs using POST /submit-job with an image reference.'
    });
});

app.post(
    '/upload-output',
    requireWorkerAuth,
    createRateLimiter({ bucket: 'output-upload', windowMs: 60 * 1000, max: 30, scope: 'worker' }),
    outputUpload.single('file'),
    (req, res) => {
    try {
        const taskId = req.body.task_id;
        if (!taskId) {
            return res.status(400).json({ error: 'task_id is required' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'output zip file is required' });
        }

        const job = jobs.get(taskId);
        if (!job) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const outputPath = req.file.path;
        const outputUrl = `${getServerUrl()}/outputs/${path.basename(outputPath)}`;

        job.output_file_path = outputPath;
        job.output_file_url = outputUrl;

        broadcastUpdate();
        logEvent('artifact_uploaded', {
            jobId: taskId,
            workerUrl: req.body?.workerUrl || null,
            bytes: req.file.size,
            outputUrl
        });
        return res.json({
            task_id: taskId,
            output_file_url: outputUrl,
            status: 'stored'
        });
    } catch (err) {
        console.error('❌ Output upload error:', err.message);
        return res.status(500).json({ error: 'Output upload failed' });
    }
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `Artifact too large. Max ${MAX_ARTIFACT_SIZE_MB} MB` });
    }
    next(err);
});

// ==================== WORKER REGISTRATION ====================
app.post(
    '/register',
    requireWorkerAuth,
    createRateLimiter({ bucket: 'worker-register', windowMs: 60 * 1000, max: 30, scope: 'worker' }),
    (req, res) => {
    const { workerUrl, capabilities } = req.body;
    if (!workerUrl) {
        return res.status(400).json({ error: 'workerUrl is required' });
    }
    const existing = workers.get(workerUrl);

    workers.set(workerUrl, {
        url: workerUrl,
        capabilities: capabilities || {},
        trustScore: existing ? existing.trustScore : 50,
        credits: existing ? existing.credits : 0,
        lastHeartbeat: Date.now(),
        status: 'online',
        jobsCompleted: existing ? existing.jobsCompleted : 0,
        jobsFailed: existing ? existing.jobsFailed : 0,
        currentJob: existing ? existing.currentJob : null,
        registeredAt: existing ? existing.registeredAt : Date.now(),
        lastAssignedAt: existing ? existing.lastAssignedAt : 0,
        jobHistory: existing ? existing.jobHistory : []
    });

    logEvent('worker_registered', {
        workerUrl,
        totalWorkers: workers.size,
        hostname: capabilities?.hostname || null
    });
    if (jobQueue.length > 0) {
        console.log(`   🔄 ${jobQueue.length} jobs queued - attempting assignment`);
    }
    broadcastUpdate();
    processQueue();  // Assign any queued jobs to the newly joined worker

    res.json({
        status: 'registered',
        trustScore: workers.get(workerUrl).trustScore,
        credits: workers.get(workerUrl).credits
    });
});

// ==================== HEARTBEAT ====================
app.post(
    '/heartbeat',
    requireWorkerAuth,
    createRateLimiter({ bucket: 'worker-heartbeat', windowMs: 60 * 1000, max: 300, scope: 'worker' }),
    (req, res) => {
    const { workerUrl } = req.body;
    const worker = workers.get(workerUrl);
    if (worker) {
        worker.lastHeartbeat = Date.now();
        if (worker.status === 'offline') {
            worker.status = 'online';
            console.log('💚 Worker back online:', workerUrl);
            broadcastUpdate();
            processQueue();  // Assign queued jobs to the worker that just came back online
        }
    }
    res.json({ status: 'ok' });
});

// ==================== JOB SUBMISSION ====================
app.post(
    '/submit-job',
    createRateLimiter({ bucket: 'submit-ip', windowMs: 60 * 1000, max: 30, scope: 'ip' }),
    createRateLimiter({ bucket: 'submit-user', windowMs: 60 * 1000, max: 60, scope: 'user' }),
    (req, res) => {
    const { description, resources_required, image } = req.body;

    if (!isSafeImageRef(image)) {
        return res.status(400).json({ error: 'Valid Docker image is required' });
    }

    const jobId = crypto.randomUUID();
    const normalizedImage = image.trim();
    const fileSignature = `image:${normalizedImage}`;
    const job = {
        id: jobId,
        files: [],
        mode: 'docker-image',
        image: normalizedImage,
        status: 'queued',
        description: description || 'No description provided',
        resources_required: resources_required || { cpu: 1, ram: 0.5, gpu: false },
        submittedAt: Date.now(), assignedWorker: null,
        startedAt: null, completedAt: null,
        result: null, error: null, retries: 0,
        fileSignature,
        targetWorker: null
    };

    jobs.set(jobId, job);
    jobQueue.push(jobId);
    logEvent('job_submitted', {
        jobId,
        image: normalizedImage,
        submitter: req.headers['x-user-id'] || null,
        ip: getRequestIp(req)
    });
    broadcastUpdate();

    res.json({ jobId, status: 'queued' });
});

// ==================== POLL-BASED JOB ASSIGNMENT ====================
// Workers call this endpoint to pull jobs (works behind NAT/firewalls)
app.post(
    '/poll-job',
    requireWorkerAuth,
    createRateLimiter({ bucket: 'poll-job', windowMs: 60 * 1000, max: 180, scope: 'worker' }),
    (req, res) => {
    const { workerUrl } = req.body;
    const worker = workers.get(workerUrl);
    
    if (!worker) {
        return res.status(404).json({ job: null, error: 'Worker not registered' });
    }
    
    // Update heartbeat on poll
    worker.lastHeartbeat = Date.now();
    if (worker.status === 'offline') {
        worker.status = 'online';
        console.log('💚 Worker back online (via poll):', workerUrl);
        broadcastUpdate();
    }
    
    // If worker is already busy, no job
    if (worker.currentJob) {
        return res.json({ job: null });
    }
    
    // No jobs in queue
    if (jobQueue.length === 0) {
        return res.json({ job: null });
    }
    
    const serverUrl = getServerUrl();
    
    // Find a suitable job for this worker
    for (let i = 0; i < jobQueue.length; i++) {
        const jobId = jobQueue[i];
        const job = jobs.get(jobId);
        if (!job) { jobQueue.splice(i, 1); i--; continue; }
        
        if (job.targetWorker && job.targetWorker !== workerUrl) {
            continue;
        }
        
        // If job targets a specific worker that's offline, allow any worker
        if (job.targetWorker && job.targetWorker === workerUrl) {
            // Perfect match
        } else if (job.targetWorker) {
            // Check if targeted worker is offline — if so, clear target
            const target = workers.get(job.targetWorker);
            if (!target || target.status === 'offline') {
                console.log('⚠️ Target worker offline, allowing any worker:', job.targetWorker);
                job.targetWorker = null;
            } else {
                continue; // Target worker is online, skip this job for other workers
            }
        }
        
        // Assign this job
        jobQueue.splice(i, 1);
        job.status = 'assigned';
        job.assignedWorker = workerUrl;
        job.assignedAt = Date.now();
        job.deadlineAt = Date.now() + JOB_MAX_RUNTIME_MS;
        worker.currentJob = jobId;
        worker.lastAssignedAt = Date.now();
        
        // Track job history (keep last 20)
        worker.jobHistory.push(job.fileSignature);
        if (worker.jobHistory.length > 20) {
            worker.jobHistory = worker.jobHistory.slice(-20);
        }
        
        const workerName = worker.capabilities?.hostname || workerUrl;
        logEvent('job_assigned', {
            jobId,
            workerUrl,
            workerName,
            assignmentMode: job.targetWorker ? 'user-selected' : 'auto-poll',
            deadlineAt: new Date(job.deadlineAt).toISOString()
        });
        
        broadcastUpdate();
        
        return res.json({
            job: {
                jobId: job.id,
                files: [],
                mode: 'docker-image',
                image: job.image || null,
                description: job.description,
                resources_required: job.resources_required,
                serverUrl
            }
        });
    }
    
    // No suitable job found
    res.json({ job: null });
});

// ==================== JOB STATUS UPDATE (from worker) ====================
app.post(
    '/job-update',
    requireWorkerAuth,
    createRateLimiter({ bucket: 'job-update', windowMs: 60 * 1000, max: 180, scope: 'worker' }),
    (req, res) => {
    const { jobId, status, result, error, output_file_url, output_warning, output_files } = req.body;
    const job = jobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    job.status = status;

    if (status === 'running') {
        job.startedAt = Date.now();
        job.deadlineAt = job.startedAt + JOB_MAX_RUNTIME_MS;
        logEvent('job_running', {
            jobId,
            workerUrl: job.assignedWorker,
            deadlineAt: new Date(job.deadlineAt).toISOString()
        });
    } else if (status === 'completed') {
        job.completedAt = Date.now();
        job.result = result;
        if (output_file_url) {
            job.output_file_url = output_file_url;
        }
        if (output_warning) {
            job.output_warning = output_warning;
        }
        if (Array.isArray(output_files)) {
            job.output_files = output_files;
        }
        const worker = workers.get(job.assignedWorker);
        if (worker) {
            worker.jobsCompleted++;
            worker.trustScore = Math.min(100, worker.trustScore + 5);
            worker.credits += 10;
            worker.currentJob = null;
        }
        logEvent('job_completed', {
            jobId,
            workerUrl: job.assignedWorker,
            durationMs: job.startedAt ? Date.now() - job.startedAt : null
        });
    } else if (status === 'failed') {
        markJobFailed(job, error || 'Job failed');
    } else if (status === 'rejected') {
        // Handle worker node dynamically rejecting the 60-second offer
        const worker = workers.get(job.assignedWorker);
        if (worker) {
            // Apply slight penalty to trust score, or no penalty
            worker.trustScore = Math.max(0, worker.trustScore - 2); 
            worker.currentJob = null;
        }
        job.status = 'queued';
        job.assignedWorker = null;
        job.retries++;
        jobQueue.unshift(job.id); // Put back to front of queue
        logEvent('job_rejected', {
            jobId,
            workerUrl: req.body?.workerUrl || job.assignedWorker,
            retries: job.retries
        });
    }

    broadcastUpdate();
    processQueue();
    res.json({ status: 'ok' });
});

// ==================== QUEUE MONITOR ====================
// With pull-based model, processQueue just logs status.
// Actual assignment happens in /poll-job when workers poll.
function processQueue() {
    if (jobQueue.length === 0) return;
    const onlineWorkers = [...workers.values()].filter(w => w.status === 'online' && !w.currentJob);
    console.log(`📊 Queue status: ${jobQueue.length} pending, ${onlineWorkers.length} idle workers (will be assigned on next poll)`);
}

// ==================== FAULT TOLERANCE: HEARTBEAT MONITOR ====================
setInterval(() => {
    const now = Date.now();
    let changed = false;

    for (const [url, worker] of workers) {
        if (now - worker.lastHeartbeat > 30000 && worker.status === 'online') {
            console.log('⚠️ Worker timed out:', url);
            worker.status = 'offline';
            changed = true;

            if (worker.currentJob) {
                const job = jobs.get(worker.currentJob);
                if (job && (job.status === 'assigned' || job.status === 'running')) {
                    job.status = 'queued';
                    job.assignedWorker = null;
                    job.retries++;
                    jobQueue.unshift(job.id);
                    logEvent('job_requeued_worker_timeout', {
                        jobId: job.id,
                        workerUrl: url,
                        retries: job.retries
                    });
                }
                worker.currentJob = null;
            }
        }
    }

    if (changed) {
        broadcastUpdate();
        processQueue();
    }
}, 10000);

setInterval(() => {
    const now = Date.now();
    let changed = false;

    for (const job of jobs.values()) {
        if ((job.status === 'assigned' || job.status === 'running') && job.deadlineAt && now > job.deadlineAt) {
            markJobFailed(job, `Job exceeded max runtime (${Math.round(JOB_MAX_RUNTIME_MS / 60000)} min)`);
            changed = true;
        }
    }

    if (changed) {
        broadcastUpdate();
        processQueue();
    }
}, 5000);

// ==================== REST API ====================
app.get('/api/workers', (req, res) => {
    // Only return online workers
    const online = [...workers.values()].filter(w => w.status === 'online');
    res.json(online);
});

app.get('/api/health', (req, res) => {
    const serverUrl = getServerUrl();
    let cloudName = 'N/A';
    let storage = 'Disk (local)';
    
    if (cloudinary) {
        try {
            const config = cloudinary.config();
            if (config && config.cloud_name) {
                cloudName = config.cloud_name;
                storage = 'Cloudinary';
            }
        } catch (err) {
            console.warn('⚠️ Error reading Cloudinary config:', err.message);
        }
    }
    
    res.json({
        status: 'ok',
        serverUrl,
        storage,
        cloudName,
        guardrails: {
            workerAuthEnabled: Boolean(WORKER_SHARED_SECRET),
            maxArtifactSizeMB: MAX_ARTIFACT_SIZE_MB,
            maxJobRuntimeMs: JOB_MAX_RUNTIME_MS
        }
    });
});
app.get('/api/jobs', (req, res) => res.json([...jobs.values()].reverse()));
app.get('/api/stats', (req, res) => res.json(getStats()));
app.get('/api/status/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

app.get('/tasks/:id/download', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
        return res.status(404).json({ error: 'Task not found' });
    }

    if (job.output_file_path && fs.existsSync(job.output_file_path)) {
        return res.download(job.output_file_path, `${job.id}-output.zip`);
    }

    if (job.output_file_url) {
        return res.redirect(job.output_file_url);
    }

    return res.status(404).json({ error: 'No output artifact available for this task' });
});

app.get('/api/network-info', (req, res) => {
    const nets = os.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                addresses.push({ name, address: net.address });
            }
        }
    }
    res.json({ addresses, port: PORT });
});

app.delete('/api/jobs/clear-queue', (req, res) => {
    const clearedCount = jobQueue.length;
    jobQueue.length = 0;
    console.log(`🗑️ Cleared ${clearedCount} queued jobs`);
    broadcastUpdate();
    res.json({ cleared: clearedCount, message: `Cleared ${clearedCount} queued jobs` });
});

// ==================== UTILITY FUNCTIONS ====================

function getServerUrl() {
    return DEFAULT_SERVER_URL;
}

// ==================== SOCKET.IO REAL-TIME ====================
function getStats() {
    const allJobs = [...jobs.values()];
    const completed = allJobs.filter(j => j.status === 'completed').length;
    const total = allJobs.length;
    return {
        totalJobs: total,
        completedJobs: completed,
        failedJobs: allJobs.filter(j => j.status === 'failed').length,
        runningJobs: allJobs.filter(j => j.status === 'running' || j.status === 'assigned').length,
        queuedJobs: jobQueue.length,
        activeWorkers: [...workers.values()].filter(w => w.status === 'online').length,
        totalWorkers: workers.size,
        totalCreditsEarned: [...workers.values()].reduce((s, w) => s + w.credits, 0),
        avgTrustScore: workers.size > 0
            ? Math.round([...workers.values()].reduce((s, w) => s + w.trustScore, 0) / workers.size) : 0,
        successRate: total > 0 ? Math.round((completed / total) * 100) : 0
    };
}

function broadcastUpdate() {
    io.emit('update', {
        workers: [...workers.values()],
        jobs: [...jobs.values()].reverse().slice(0, 50),
        stats: getStats()
    });
}

io.on('connection', (socket) => {
    console.log('📡 Dashboard connected');
    socket.emit('update', {
        workers: [...workers.values()],
        jobs: [...jobs.values()].reverse().slice(0, 50),
        stats: getStats()
    });
});

// ==================== START ====================
server.listen(PORT, '0.0.0.0', () => {
    if (!WORKER_SHARED_SECRET) {
        logEvent('warning', { message: 'WORKER_SHARED_SECRET is not set; worker auth is disabled' });
    }
    console.log('SERVER_READY');
    console.log(`🚀 Server running on port ${PORT}`);
});