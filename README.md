# SharingIsCaring — Decentralized Idle Compute Sharing Platform

A secure platform that allows students and developers to share idle GPU/CPU resources over the internet for AI training and research workloads.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   Electron Desktop App                    │
│  ┌──────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │  System   │  │   Dashboard UI   │  │  Worker Toggle │  │
│  │  Tray     │  │  (index.html)    │  │               │  │
│  └──────────┘  └────────┬─────────┘  └───────┬───────┘  │
│                         │ Socket.IO           │ IPC      │
│                ┌────────▼─────────┐  ┌───────▼───────┐  │
│                │   Server.js       │  │  Worker.js     │  │
│                │  (Express+Socket) │  │  (Compute)     │  │
│                └──────────────────┘  └───────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Features

| Feature | Description |
|---------|-------------|
| **Task Execution** | Upload Python scripts + datasets, execute on remote workers |
| **Docker Containerization** | Jobs run in isolated `python:3.10-slim` containers |
| **Trust & Verification** | Trust scores (0-100) based on job completion history |
| **Credit System** | Workers earn credits for completed jobs |
| **Fair Scheduling** | Jobs assigned to highest-trust available worker |
| **Fault Tolerance** | Heartbeat monitoring, automatic job re-queuing on worker dropout |
| **Real-time Dashboard** | Socket.IO powered live updates of workers, jobs, and stats |
| **Desktop App** | Electron wrapper with system tray and one-click worker toggle |

## Quick Start

### Prerequisites
- Node.js 18+
- Python 3.10+
- Docker Desktop (optional, for containerized execution)

### Install
```bash
npm install
```

### Run as Desktop App
```bash
npm start
```

### Run Headless (Server + Worker separately)
```bash
# Terminal 1: Start server
npm run server

# Terminal 2: Start worker
npm run worker
```

Then open `http://localhost:3000` in a browser.

## Production Baseline (Central Server + Remote Workers)

Use one shared public base URL across Electron, web clients, and workers.

1. Set server URL in both config files:
	- `.server-config.json`
	- `server-config.json`
2. Set these server environment variables:
	- `CENTRAL_SERVER_URL=https://your-app.onrender.com`
	- `WORKER_SHARED_SECRET=<strong-random-token>`
	- `MAX_ARTIFACT_SIZE_MB=50`
	- `JOB_MAX_RUNTIME_MS=900000`
3. Start each remote worker with the same token:

```powershell
$env:SERVER_URL="https://your-app.onrender.com"
$env:WORKER_SHARED_SECRET="<strong-random-token>"
npm run worker
```

Quick smoke checks:

```powershell
Invoke-RestMethod https://your-app.onrender.com/api/health
Invoke-RestMethod https://your-app.onrender.com/api/workers
Invoke-RestMethod https://your-app.onrender.com/api/jobs
```

The health payload now includes guardrail settings:
- `workerAuthEnabled`
- `maxArtifactSizeMB`
- `maxJobRuntimeMs`

## Demo: Training a CNN

1. Launch the app with `npm start`
2. Toggle the Worker switch ON in the sidebar
3. Build and push an image containing your training code:
	- `docker build -t username/ml-job:latest .`
	- `docker push username/ml-job:latest`
4. Go to **Submit Job** and enter `username/ml-job:latest`
5. Click **Submit Job**
5. Watch the job execute in real-time on the Dashboard

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/register` | Register a worker |
| POST | `/heartbeat` | Worker heartbeat |
| POST | `/upload` | Disabled (docker-only mode; returns 410) |
| POST | `/upload-output` | Upload output.zip artifact from worker |
| POST | `/submit-job` | Submit a job |
| POST | `/job-update` | Worker reports job status |
| GET | `/api/workers` | List workers |
| GET | `/api/jobs` | List jobs |
| GET | `/api/stats` | Dashboard stats |
| GET | `/api/status/:id` | Job status |
| GET | `/tasks/:id/download` | Download output.zip for completed job |

### Job Submission Mode

Docker image mode:

```json
{
	"mode": "docker-image",
	"description": "Train in container",
	"image": "username/ml-job:latest",
	"resources_required": { "cpu": 2, "ram": 2, "gpu": true }
}
```

Server sends the image reference and worker executes:

`docker pull <image>` then `docker run --rm <image>`

Containerized jobs should write outputs into:

`/workspace/output`

Worker bundles this directory into `output.zip`, uploads via `/upload-output`, and the UI exposes a download link.

## Tech Stack

- **Backend**: Node.js, Express, Socket.IO
- **Frontend**: Vanilla HTML/CSS/JS with glassmorphism dark theme
- **Desktop**: Electron with custom title bar + system tray
- **Containerization**: Docker
- **ML Demos**: PyTorch, NumPy, Pandas

## License

ISC
