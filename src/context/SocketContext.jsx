import React, { createContext, useContext, useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const SocketContext = createContext();

export const useSocket = () => {
    return useContext(SocketContext);
};

export const SocketProvider = ({ children }) => {
    const envServerUrl = import.meta.env.VITE_SERVER_URL || null;
    const [socket, setSocket] = useState(null);
    const [connected, setConnected] = useState(false);
    const [currentUrl, setCurrentUrl] = useState(envServerUrl || 'https://tp-00zg.onrender.com');
    
    // Global state arrays updated directly by socket events
    const [workers, setWorkers] = useState([]);
    const [jobs, setJobs] = useState([]);

    useEffect(() => {
        const withTimeout = async (url) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 2500);
            try {
                const res = await fetch(`${url}/api/health`, { signal: controller.signal });
                return res.ok;
            } catch {
                return false;
            } finally {
                clearTimeout(timer);
            }
        };

        const resolveServerUrl = async () => {
            let configuredUrl = null;

            if (window.electronAPI?.getServerUrl) {
                try {
                    configuredUrl = await window.electronAPI.getServerUrl();
                    if (configuredUrl) {
                        console.log(`[SocketContext] Loaded configured server URL: ${configuredUrl}`);
                    }
                } catch (err) {
                    console.warn('[SocketContext] Failed to read configured server URL:', err);
                }
            }

            const candidates = [configuredUrl, envServerUrl, 'https://tp-00zg.onrender.com', 'http://localhost:3001', 'http://localhost:3000']
                .filter(Boolean);

            for (const candidate of candidates) {
                if (await withTimeout(candidate)) {
                    setCurrentUrl(candidate);
                    console.log(`[SocketContext] Connected to healthy server: ${candidate}`);
                    return;
                }
            }

            if (configuredUrl) {
                setCurrentUrl(configuredUrl);
            }
        };

        resolveServerUrl();
    }, []);
    const [stats, setStats] = useState({
        totalJobs: 0,
        completedJobs: 0,
        failedJobs: 0,
        runningJobs: 0,
        queuedJobs: 0,
        activeWorkers: 0,
        totalWorkers: 0,
        totalCreditsEarned: 0,
        avgTrustScore: 0,
        successRate: 0
    });

    useEffect(() => {
        const newSocket = io(currentUrl);
        setSocket(newSocket);

        newSocket.on('connect', () => setConnected(true));
        newSocket.on('disconnect', () => setConnected(false));
        
        newSocket.on('update', (data) => {
            if (data.workers) setWorkers(data.workers);
            if (data.jobs) setJobs(data.jobs);
            if (data.stats) setStats(data.stats);
        });

        return () => newSocket.disconnect();
    }, [currentUrl]);

    const connectToNetwork = (url) => {
        setCurrentUrl(url);
    };

    return (
        <SocketContext.Provider value={{ socket, connected, currentUrl, workers, jobs, stats, connectToNetwork }}>
            {children}
        </SocketContext.Provider>
    );
};
