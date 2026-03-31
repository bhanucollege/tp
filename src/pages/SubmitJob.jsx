import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useTheme } from '../hooks/useTheme';

const cuteNotes = [
    'Use a registry image tag like username/ml-job:latest.',
    'Your image should include all dependencies and startup command.',
    'Write output artifacts to /workspace/output inside the container.',
    'Keep image tags versioned for reproducible runs.'
];

const SubmitJob = () => {
    const { currentUrl } = useSocket();
    const theme = useTheme();
    const [submitMode, setSubmitMode] = useState('docker-image');
    const [dockerImage, setDockerImage] = useState('');
    const [selectedFiles, setSelectedFiles] = useState([]);
    const [description, setDescription] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const navigate = useNavigate();

    const submitJob = async () => {
        if (!description.trim()) {
            return;
        }

        if (submitMode === 'docker-image' && !dockerImage.trim()) {
            return;
        }

        if (submitMode === 'python-files' && selectedFiles.length === 0) {
            return;
        }

        if (!currentUrl) {
            alert('Server URL not configured. Please check your connection.');
            return;
        }

        setSubmitting(true);

        try {
            try {
                await axios.get(`${currentUrl}/api/health`, { timeout: 5000 });
            } catch (healthError) {
                console.warn('[SubmitJob] Health check warning:', healthError.message);
            }

            if (submitMode === 'docker-image') {
                const payload = {
                    description: description.trim(),
                    resources_required: { cpu: 2, ram: 2, gpu: false },
                    mode: 'docker-image',
                    image: dockerImage.trim()
                };
                await axios.post(`${currentUrl}/submit-job`, payload, { timeout: 10000 });
            } else {
                const formData = new FormData();
                formData.append('description', description.trim());
                formData.append('resources_required', JSON.stringify({ cpu: 2, ram: 2, gpu: false }));
                for (const file of selectedFiles) {
                    formData.append('files', file);
                }
                await axios.post(`${currentUrl}/upload`, formData, {
                    timeout: 30000,
                    headers: { 'Content-Type': 'multipart/form-data' }
                });
            }

            setDockerImage('');
            setSelectedFiles([]);
            setDescription('');
            navigate('/');
        } catch (error) {
            const errorMessage = error.response?.data?.error || error.message;
            const statusCode = error.response?.status;

            let detailedError = errorMessage;
            if (error.code === 'ECONNABORTED') {
                detailedError = 'Request timeout - server is not responding.';
            } else if (error.code === 'ENOTFOUND') {
                detailedError = 'Server domain not found - check the URL.';
            } else if (error.message === 'Network Error') {
                detailedError = 'Network error - check your internet and firewall settings.';
            }

            alert(
                `Error submitting job (${statusCode || 'network error'})\n\nServer: ${currentUrl}\nError: ${detailedError}`
            );
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <section className="sec submit-page" id="sec-submit">
            <div className="page-hero">
                <div>
                    <p className="eyebrow">submit task</p>
                    <h1 className="stitle">{theme === 'coquette' ? 'Compose cloud note' : 'Compose task'}</h1>
                    <p className="hero-copy">
                        {theme === 'coquette'
                            ? 'Submit a Docker image reference and dispatch a reproducible container run.'
                            : 'Submit a Docker image reference so workers pull and run the same container environment.'}
                    </p>
                </div>
            </div>

            <div className="submit-layout">
                <article className="card chat-window mail-window">
                    <div className="chat-window-grid">
                        <div className="chat-stage">
                            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                                <button
                                    className={`btn ${submitMode === 'docker-image' ? 'btn-p' : 'btn-g'}`}
                                    type="button"
                                    onClick={() => setSubmitMode('docker-image')}
                                >
                                    Docker image
                                </button>
                                <button
                                    className={`btn ${submitMode === 'python-files' ? 'btn-p' : 'btn-g'}`}
                                    type="button"
                                    onClick={() => setSubmitMode('python-files')}
                                >
                                    Upload files
                                </button>
                            </div>

                            <div className="compose-window-bar">
                                <div className="compose-window-dots" aria-hidden="true">
                                    <span></span>
                                    <span></span>
                                    <span></span>
                                </div>
                                <div className="compose-window-title">
                                    <strong>{theme === 'coquette' ? 'Cloud note draft' : 'Task draft'}</strong>
                                    <span>{theme === 'coquette' ? 'image reference above, note below' : 'container image first, brief below'}</span>
                                </div>
                                <div className="compose-window-tag">
                                    {theme === 'coquette' ? 'draft' : 'compose'}
                                </div>
                            </div>

                            <div className="compose-section-head">
                                <p className="eyebrow">docker image</p>
                                <span className="sl2">{theme === 'coquette' ? 'Add image reference first' : 'Provide image reference first'}</span>
                            </div>

                            {submitMode === 'docker-image' ? (
                                <div style={{ marginBottom: '16px' }}>
                                    <label className="composer-label" htmlFor="docker-image">docker image reference</label>
                                    <input
                                        id="docker-image"
                                        type="text"
                                        value={dockerImage}
                                        onChange={(event) => setDockerImage(event.target.value)}
                                        placeholder="username/ml-job:latest"
                                        style={{ width: '100%', marginTop: '8px', padding: '12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg-0)', color: 'var(--text)' }}
                                    />
                                    <p className="sl2" style={{ marginTop: '8px' }}>
                                        Worker will run: docker pull {dockerImage || '<image>'} && docker run --rm {dockerImage || '<image>'}
                                    </p>
                                </div>
                            ) : (
                                <div style={{ marginBottom: '16px' }}>
                                    <label className="composer-label" htmlFor="job-files">upload python/csv files</label>
                                    <input
                                        id="job-files"
                                        type="file"
                                        multiple
                                        onChange={(event) => setSelectedFiles(Array.from(event.target.files || []))}
                                        style={{ width: '100%', marginTop: '8px' }}
                                    />
                                    <p className="sl2" style={{ marginTop: '8px' }}>
                                        Select your script and dataset files. Worker executes in python-files mode.
                                    </p>
                                </div>
                            )}

                            <div className="composer-shell message-shell">
                                <div className="compose-section-head">
                                    <div>
                                        <label className="composer-label" htmlFor="job-message">description box</label>
                                        <span className="sl2">{theme === 'coquette' ? 'Write the task note below' : 'Write the task description below'}</span>
                                    </div>
                                </div>
                                <textarea
                                    id="job-message"
                                    value={description}
                                    onChange={(event) => setDescription(event.target.value)}
                                    placeholder="Tell the workers what this task does, what success looks like, and any little details they should not miss..."
                                />

                                <div className="composer-footer">
                                    <button
                                        className={`btn btn-p ${submitting ? 'is-loading' : ''}`}
                                        onClick={submitJob}
                                        disabled={
                                            submitting ||
                                            !description.trim() ||
                                            (submitMode === 'docker-image' && !dockerImage.trim()) ||
                                            (submitMode === 'python-files' && selectedFiles.length === 0)
                                        }
                                    >
                                        {submitting && (
                                            <span className="spark-loader" aria-hidden="true">
                                                <span></span>
                                                <span></span>
                                                <span></span>
                                            </span>
                                        )}
                                        {submitting ? (theme === 'coquette' ? 'Sending cloud note' : 'Dispatching task') : (theme === 'coquette' ? 'Send to the clouds' : 'Dispatch task')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </article>

                <aside className="submit-side">
                    <article className="card sticky-card">
                        <p className="eyebrow">{theme === 'coquette' ? 'cute notes' : 'field notes'}</p>
                        <h2 className="card-title">{theme === 'coquette' ? 'Little reminders on the side' : 'Quick reminders on the side'}</h2>
                        <div className="sticky-list">
                            {cuteNotes.map((note) => (
                                <div className="sticky-note" key={note}>
                                    {note}
                                </div>
                            ))}
                        </div>
                    </article>

                    <article className="card resource-card">
                        <p className="eyebrow">resource sketch</p>
                        <h2 className="card-title">Estimated fit</h2>
                        <div className="resource-list">
                            <div className="resource-row"><span>Execution mode</span><strong>Docker image</strong></div>
                            <div className="resource-row"><span>Image tag</span><strong>{dockerImage || 'not set'}</strong></div>
                            <div className="resource-row"><span>Runtime</span><strong>docker pull + run</strong></div>
                            <div className="resource-row"><span>Output path</span><strong>/workspace/output</strong></div>
                        </div>
                    </article>
                </aside>
            </div>
        </section>
    );
};

export default SubmitJob;
