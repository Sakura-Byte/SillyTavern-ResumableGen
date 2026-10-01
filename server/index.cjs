/**
 * Resumable Generation - server plugin
 *
 * Runs generation requests in a server-side "job" that is decoupled from the browser connection.
 * The job calls SillyTavern's own generate endpoint over a loopback connection (so the core abort-on-disconnect
 * logic is bound to *our* socket, not the browser's), buffers the response, and lets the client re-attach
 * at any byte offset.
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { version } = require('../package.json');

/** Bump when the client <-> server API changes incompatibly. Must match PROTOCOL in client/index.js. */
const PROTOCOL = 1;

const ALLOWED_TARGETS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/novelai/generate',
]);

/** How long to keep finished jobs that were never acknowledged by a client. */
const FINISHED_TTL_MS = 60 * 60 * 1000;
/** How long to keep acknowledged jobs (small window in case the page dies right after reading). */
const ACKED_TTL_MS = 2 * 60 * 1000;
/** Hard limit on running time of a single job. */
const MAX_JOB_MS = 30 * 60 * 1000;
/** Max jobs kept per user. */
const MAX_JOBS_PER_USER = 20;

/** @type {Map<string, Job>} */
const jobs = new Map();
let cleanupTimer = null;

class Job extends EventEmitter {
    constructor(user, target, meta) {
        super();
        this.setMaxListeners(50);
        this.id = crypto.randomUUID();
        this.user = user;
        this.target = target;
        this.meta = meta;
        this.createdAt = Date.now();
        this.finishedAt = 0;
        this.ackedAt = 0;
        /** @type {number|null} */
        this.status = null;
        this.contentType = '';
        /** @type {Buffer[]} */
        this.chunks = [];
        this.size = 0;
        this.done = false;
        this.cancelled = false;
        this.error = '';
        /** @type {http.ClientRequest|null} */
        this.request = null;
    }

    get headReceived() {
        return this.status !== null;
    }

    setHead(status, contentType) {
        this.status = status;
        this.contentType = contentType || '';
        this.emit('head');
    }

    push(chunk) {
        this.chunks.push(chunk);
        this.size += chunk.length;
        this.emit('data', chunk);
    }

    finish(error = '') {
        if (this.done) return;
        this.done = true;
        this.error = error;
        this.finishedAt = Date.now();
        this.request = null;
        if (!this.headReceived) {
            this.status = 502;
            this.contentType = 'application/json';
            const body = Buffer.from(JSON.stringify({ error: { message: `Resumable generation failed: ${error || 'unknown error'}` } }));
            this.chunks.push(body);
            this.size += body.length;
            this.emit('head');
        }
        this.emit('end');
    }

    slice(offset) {
        if (offset <= 0) return Buffer.concat(this.chunks);
        if (offset >= this.size) return Buffer.alloc(0);
        return Buffer.concat(this.chunks).subarray(offset);
    }

    toJSON() {
        return {
            id: this.id,
            target: this.target,
            meta: this.meta,
            createdAt: this.createdAt,
            finishedAt: this.finishedAt,
            acked: !!this.ackedAt,
            done: this.done,
            cancelled: this.cancelled,
            error: this.error,
            status: this.status,
            size: this.size,
        };
    }
}

function getUserHandle(req) {
    return req.user?.profile?.handle ?? '';
}

function getJob(req, res) {
    const job = jobs.get(String(req.params.id));
    if (!job || job.user !== getUserHandle(req)) {
        res.status(404).json({ error: 'job not found' });
        return null;
    }
    return job;
}

function isLoopback(address) {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Starts the loopback request to SillyTavern's own endpoint.
 * @param {Job} job
 * @param {import('express').Request} req Original request (for auth headers and local address)
 * @param {Buffer} body Request body to send
 */
function runJob(job, req, body) {
    const socket = /** @type {import('node:tls').TLSSocket} */ (req.socket);
    const isHttps = !!socket.encrypted;
    const port = socket.localPort;
    const localAddress = String(socket.localAddress || '');
    const family = localAddress.includes(':') && !localAddress.startsWith('::ffff:') ? 6 : 4;

    // Prefer loopback (whitelisted by default); fall back to the address the browser connected to.
    const hosts = isLoopback(localAddress)
        ? [localAddress.replace('::ffff:', '')]
        : [family === 6 ? '::1' : '127.0.0.1', localAddress.replace('::ffff:', '')];

    const headers = {
        'content-type': 'application/json',
        'content-length': body.length,
        'accept-encoding': 'identity',
    };
    for (const name of ['cookie', 'x-csrf-token', 'authorization', 'host', 'user-agent']) {
        if (req.headers[name]) headers[name] = req.headers[name];
    }

    const timeout = setTimeout(() => {
        job.request?.destroy();
        job.finish('job timed out');
    }, MAX_JOB_MS);
    job.once('end', () => clearTimeout(timeout));

    const attempt = (index) => {
        const transport = isHttps ? https : http;
        const request = transport.request({
            host: hosts[index],
            port,
            method: 'POST',
            path: job.target,
            headers,
            agent: false,
            rejectUnauthorized: false,
        });
        job.request = request;

        let connected = false;
        request.on('socket', (s) => s.once(isHttps ? 'secureConnect' : 'connect', () => { connected = true; }));
        request.on('response', (response) => {
            job.setHead(response.statusCode ?? 500, String(response.headers['content-type'] || ''));
            response.on('data', (chunk) => job.push(chunk));
            response.on('end', () => job.finish(job.cancelled ? 'cancelled' : ''));
            response.on('error', (err) => job.finish(err.message));
            response.on('aborted', () => job.finish(job.cancelled ? 'cancelled' : 'upstream aborted'));
        });
        request.on('error', (err) => {
            if (!connected && !job.cancelled && index + 1 < hosts.length) {
                return attempt(index + 1);
            }
            job.finish(job.cancelled ? 'cancelled' : err.message);
        });
        request.end(body);
    };

    attempt(0);
}

function startJob(req, res) {
    const { target, meta, payload } = req.body ?? {};
    if (typeof target !== 'string' || !ALLOWED_TARGETS.has(target) || typeof payload !== 'object' || payload === null) {
        return res.status(400).json({ error: 'invalid request' });
    }

    const user = getUserHandle(req);
    const userJobs = [...jobs.values()].filter(j => j.user === user).sort((a, b) => a.createdAt - b.createdAt);
    while (userJobs.length >= MAX_JOBS_PER_USER) {
        const old = userJobs.shift();
        old.request?.destroy();
        jobs.delete(old.id);
    }

    const job = new Job(user, target, {
        ...(typeof meta === 'object' && meta ? meta : {}),
        source: payload.chat_completion_source ?? payload.api_type ?? null,
        stream: !!payload.stream,
    });
    jobs.set(job.id, job);
    runJob(job, req, Buffer.from(JSON.stringify(payload)));
    return res.json({ id: job.id });
}

function streamJob(req, res) {
    const job = getJob(req, res);
    if (!job) return;
    const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);

    let closed = false;
    const onData = (chunk) => { if (!closed) res.write(chunk); };
    const onEnd = () => { if (!closed) res.end(); cleanup(); };
    const cleanup = () => {
        closed = true;
        job.off('head', onHead);
        job.off('data', onData);
        job.off('end', onEnd);
    };

    const onHead = () => {
        if (closed) return;
        res.status(job.status ?? 200);
        if (job.contentType) res.setHeader('Content-Type', job.contentType);
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Resumable-Job', job.id);
        res.flushHeaders();
        const buffered = job.slice(offset);
        if (buffered.length) res.write(buffered);
        if (job.done) {
            res.end();
            cleanup();
            return;
        }
        job.on('data', onData);
        job.once('end', onEnd);
    };

    // Detaching the browser only stops relaying; the job keeps running.
    res.on('close', cleanup);

    if (job.headReceived) {
        onHead();
    } else {
        job.once('head', onHead);
    }
}

function cancelJob(req, res) {
    const job = getJob(req, res);
    if (!job) return;
    if (!job.done) {
        job.cancelled = true;
        job.request?.destroy();
        job.finish('cancelled');
    }
    job.ackedAt = Date.now();
    res.json({ ok: true });
}

function ackJob(req, res) {
    const job = getJob(req, res);
    if (!job) return;
    job.ackedAt = Date.now();
    res.json({ ok: true });
}

function deleteJob(req, res) {
    const job = getJob(req, res);
    if (!job) return;
    job.request?.destroy();
    jobs.delete(job.id);
    res.json({ ok: true });
}

function cleanupJobs() {
    const now = Date.now();
    for (const job of jobs.values()) {
        if (!job.done) continue;
        if ((job.ackedAt && now - job.ackedAt > ACKED_TTL_MS) || now - job.finishedAt > FINISHED_TTL_MS) {
            jobs.delete(job.id);
        }
    }
}

async function init(router) {
    router.get('/info', (_req, res) => res.json({ version, protocol: PROTOCOL }));
    router.post('/start', startJob);
    router.get('/jobs', (req, res) => {
        const user = getUserHandle(req);
        res.json([...jobs.values()].filter(j => j.user === user).map(j => j.toJSON()));
    });
    router.get('/jobs/:id', (req, res) => {
        const job = getJob(req, res);
        if (job) res.json(job.toJSON());
    });
    router.get('/jobs/:id/stream', streamJob);
    router.post('/jobs/:id/cancel', cancelJob);
    router.post('/jobs/:id/ack', ackJob);
    router.delete('/jobs/:id', deleteJob);
    cleanupTimer = setInterval(cleanupJobs, 60 * 1000);
    cleanupTimer.unref?.();
    console.log(`[resumable-gen] Resumable generation plugin v${version} loaded`);
}

async function exit() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    for (const job of jobs.values()) job.request?.destroy();
    jobs.clear();
}

module.exports = {
    init,
    exit,
    info: {
        id: 'resumable-gen',
        name: 'Resumable Generation',
        description: 'Keeps generation requests running on the server and lets clients reconnect to them.',
    },
};
