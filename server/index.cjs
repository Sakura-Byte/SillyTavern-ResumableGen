/**
 * Resumable Generation - server plugin
 *
 * Runs generation requests in a server-side "job" that is decoupled from the browser connection.
 * The job calls SillyTavern's own generate endpoint over a loopback connection (so the core abort-on-disconnect
 * logic is bound to *our* socket, not the browser's), buffers the response, and lets the client re-attach
 * at any byte offset.
 *
 * Optionally, empty responses (e.g. blocked by a content filter) are retried: the response is held back until it
 * contains an actual reply, and the upstream request is repeated if it ends without one.
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ContentDetector } = require('./detect.cjs');
const { version } = require('../package.json');

/** Bump when the client <-> server API changes incompatibly. Must match PROTOCOL in client/index.js. */
const PROTOCOL = 2;

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
/** Hard limit on running time of a single job, including retries. */
const MAX_JOB_MS = 30 * 60 * 1000;
/** Max jobs kept per user. */
const MAX_JOBS_PER_USER = 20;
/** Upper bounds for client-provided retry settings. */
const MAX_RETRIES = 10;
const MAX_RETRY_DELAY_MS = 60 * 1000;

/** @type {Map<string, Job>} */
const jobs = new Map();
let cleanupTimer = null;

/**
 * @typedef {object} RetryOptions
 * @property {boolean} enabled Retry empty responses
 * @property {number} maxRetries Max number of retries (not counting the first attempt)
 * @property {number} delayMs Delay before each retry
 * @property {boolean} retryOnError Also retry HTTP errors and connection failures
 * @property {boolean} reasoningCounts Reasoning without reply text counts as a non-empty response
 */

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
        /** @type {Array<[number, number]>} [end byte offset, ms since job creation] for each received chunk */
        this.timeline = [];
        this.done = false;
        this.cancelled = false;
        this.error = '';
        /** Current attempt number (1-based). */
        this.attempt = 0;
        this.maxAttempts = 1;
        /** @type {string[]} Why each retry happened */
        this.retryReasons = [];
        /** True if every attempt came back empty. */
        this.exhausted = false;
        /** @type {http.ClientRequest|null} */
        this.request = null;
        /** @type {NodeJS.Timeout|null} */
        this.retryTimer = null;
    }

    get headReceived() {
        return this.status !== null;
    }

    setHead(status, contentType) {
        if (this.headReceived) return;
        this.status = status;
        this.contentType = contentType || '';
        this.emit('head');
    }

    push(chunk) {
        this.chunks.push(chunk);
        this.size += chunk.length;
        this.timeline.push([this.size, Date.now() - this.createdAt]);
        this.emit('data', chunk);
    }

    finish(error = '') {
        if (this.done) return;
        this.done = true;
        this.error = error;
        this.finishedAt = Date.now();
        this.request = null;
        if (this.retryTimer) clearTimeout(this.retryTimer);
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

    /** Stops the job, including a pending retry. */
    abort(reason) {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.request?.destroy();
        this.finish(reason);
    }

    slice(offset) {
        if (offset <= 0) return Buffer.concat(this.chunks);
        if (offset >= this.size) return Buffer.alloc(0);
        return Buffer.concat(this.chunks).subarray(offset);
    }

    toJSON(withTimeline = false) {
        return {
            ...(withTimeline ? { timeline: this.timeline } : {}),
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
            attempt: this.attempt,
            maxAttempts: this.maxAttempts,
            retryReasons: this.retryReasons,
            exhausted: this.exhausted,
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
 * Parses and clamps the retry options sent by the client.
 * @param {any} raw
 * @returns {RetryOptions}
 */
function parseRetryOptions(raw) {
    const maxRetries = Math.min(MAX_RETRIES, Math.max(0, Math.floor(Number(raw?.maxRetries) || 0)));
    return {
        enabled: !!raw?.enabled && maxRetries > 0,
        maxRetries,
        delayMs: Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Number(raw?.delayMs) || 0)),
        retryOnError: !!raw?.retryOnError,
        reasoningCounts: !!raw?.reasoningCounts,
    };
}

/**
 * Starts the loopback request(s) to SillyTavern's own endpoint.
 * @param {Job} job
 * @param {import('express').Request} req Original request (for auth headers and local address)
 * @param {Buffer} body Request body to send
 * @param {RetryOptions} retry Retry options
 */
function runJob(job, req, body, retry) {
    const socket = /** @type {import('node:tls').TLSSocket} */ (req.socket);
    const isHttps = !!socket.encrypted;
    const transport = isHttps ? https : http;
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

    const timeout = setTimeout(() => job.abort('job timed out'), MAX_JOB_MS);
    job.once('end', () => clearTimeout(timeout));
    job.maxAttempts = retry.enabled ? 1 + retry.maxRetries : 1;

    /**
     * Retries if attempts are left, otherwise delivers the final result.
     * @param {string} reason Why the attempt failed
     * @param {() => void} deliver Delivers the result of the failed attempt as-is
     */
    const retryOrDeliver = (reason, deliver) => {
        if (job.cancelled || job.done) return;
        if (job.attempt < job.maxAttempts) {
            job.retryReasons.push(reason);
            console.log(`[resumable-gen] Job ${job.id}: ${reason}, retrying (${job.attempt}/${job.maxAttempts - 1})`);
            job.emit('retry');
            job.retryTimer = setTimeout(startAttempt, retry.delayMs);
            return;
        }
        deliver();
    };

    /**
     * Delivers a failed final attempt. If a 2xx head was already sent for an earlier attempt, the error is
     * delivered in the body in a form SillyTavern reports to the user.
     */
    const deliverError = (status, contentType, buffers, message) => {
        if (!job.headReceived) {
            if (buffers.length === 0) {
                buffers = [Buffer.from(JSON.stringify({ error: { message } }))];
                contentType = 'application/json';
            }
            job.setHead(status, contentType);
            buffers.forEach(b => job.push(b));
            job.finish(message);
            return;
        }
        const error = JSON.stringify({ error: { message } });
        job.push(Buffer.from(job.meta.stream ? `data: ${error}\n\n` : error));
        job.finish(message);
    };

    const startAttempt = () => {
        if (job.cancelled || job.done) return;
        job.retryTimer = null;
        job.attempt++;
        connect(0);
    };

    const connect = (hostIndex) => {
        const request = transport.request({
            host: hosts[hostIndex],
            port,
            method: 'POST',
            path: job.target,
            headers,
            agent: false,
            rejectUnauthorized: false,
        });
        job.request = request;

        let connected = false;
        let settled = false;
        /** Runs the outcome of this attempt once, whichever of end/error/aborted fires first. */
        const settle = (fn) => {
            if (settled) return;
            settled = true;
            if (job.cancelled) return job.finish('cancelled');
            fn();
        };

        request.on('socket', (s) => s.once(isHttps ? 'secureConnect' : 'connect', () => { connected = true; }));
        request.on('response', (response) => {
            const status = response.statusCode ?? 500;
            const contentType = String(response.headers['content-type'] || '');

            if (status < 200 || status >= 300) {
                /** @type {Buffer[]} */
                const buffers = [];
                const onDone = () => settle(() => {
                    const message = `HTTP ${status}: ${Buffer.concat(buffers).toString('utf8').slice(0, 1000)}`;
                    const deliver = () => deliverError(status, contentType, buffers, message);
                    retry.enabled && retry.retryOnError ? retryOrDeliver(`HTTP ${status}`, deliver) : deliver();
                });
                response.on('data', (chunk) => buffers.push(chunk));
                response.on('end', onDone);
                response.on('error', onDone);
                response.on('aborted', onDone);
                return;
            }

            // A 2xx head is sent right away, so the client can hand the response to SillyTavern (which then shows
            // the message being generated) even while the body is held back for retries.
            job.setHead(status, contentType);

            if (!retry.enabled) {
                response.on('data', (chunk) => job.push(chunk));
                response.on('end', () => settle(() => job.finish('')));
                response.on('error', (err) => settle(() => job.finish(err.message)));
                response.on('aborted', () => settle(() => job.finish('upstream aborted')));
                return;
            }

            const detector = new ContentDetector({ reasoningCounts: retry.reasoningCounts });
            /** @type {Buffer[]} */
            const pending = [];
            let released = false;
            const release = () => {
                released = true;
                pending.splice(0).forEach(c => job.push(c));
            };

            response.on('data', (chunk) => {
                if (released) return job.push(chunk);
                pending.push(chunk);
                if (detector.feed(chunk)) release();
            });
            response.on('end', () => settle(() => {
                if (released) return job.finish('');
                const verdict = detector.finish();
                if (verdict === 'content' || (verdict === 'error' && !retry.retryOnError)) {
                    release();
                    return job.finish('');
                }
                retryOrDeliver(verdict === 'error' ? 'error response' : 'empty response', () => {
                    job.exhausted = verdict === 'empty';
                    release();
                    job.finish('');
                });
            }));
            const onBroken = (message) => settle(() => {
                // Part of the reply was already sent; it can't be retried transparently.
                if (released) return job.finish(message);
                const deliver = () => deliverError(502, 'application/json', [], message);
                retry.retryOnError ? retryOrDeliver('connection lost', deliver) : deliver();
            });
            response.on('error', (err) => onBroken(err.message));
            response.on('aborted', () => onBroken('upstream aborted'));
        });
        request.on('error', (err) => {
            if (!connected && !job.cancelled && hostIndex + 1 < hosts.length) {
                settled = true;
                return connect(hostIndex + 1);
            }
            settle(() => {
                const deliver = () => deliverError(502, 'application/json', [], err.message);
                retry.enabled && retry.retryOnError ? retryOrDeliver(err.message, deliver) : deliver();
            });
        });
        request.end(body);
    };

    startAttempt();
}

function startJob(req, res) {
    const { target, meta, payload, options } = req.body ?? {};
    if (typeof target !== 'string' || !ALLOWED_TARGETS.has(target) || typeof payload !== 'object' || payload === null) {
        return res.status(400).json({ error: 'invalid request' });
    }

    const user = getUserHandle(req);
    const userJobs = [...jobs.values()].filter(j => j.user === user).sort((a, b) => a.createdAt - b.createdAt);
    while (userJobs.length >= MAX_JOBS_PER_USER) {
        const old = userJobs.shift();
        old.abort('evicted');
        jobs.delete(old.id);
    }

    const job = new Job(user, target, {
        ...(typeof meta === 'object' && meta ? meta : {}),
        source: payload.chat_completion_source ?? payload.api_type ?? null,
        stream: !!payload.stream,
    });
    jobs.set(job.id, job);
    runJob(job, req, Buffer.from(JSON.stringify(payload)), parseRetryOptions(options?.retry));
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
        job.abort('cancelled');
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
    job.abort('deleted');
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
        if (job) res.json(job.toJSON(req.query.timeline === '1'));
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
    for (const job of jobs.values()) job.abort('server shutting down');
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
