/**
 * Resumable Generation - UI extension
 *
 * Routes generation requests through the `resumable-gen` server plugin. The plugin keeps the request running on the
 * server, and this extension transparently re-attaches to it when the browser connection drops (e.g. iOS suspending
 * a backgrounded tab). If the whole page was reloaded, unfinished results can be recovered into the chat.
 */
import { extractMessageFromData } from '../../../../../script.js';
import { getStreamingReply } from '../../../../openai.js';
import { getMessageTimeStamp } from '../../../../RossAscends-mods.js';

const BASE = '/api/plugins/resumable-gen';
/** Must match PROTOCOL in server/index.cjs. */
const PROTOCOL = 2;
const SETTINGS_KEY = 'resumable-gen';
const README_URL = 'https://github.com/Sakura-Byte/SillyTavern-ResumableGen#readme';
const NOTICE_DISMISS_KEY = 'resumable-gen:dismiss-notice';
const TARGETS = {
    '/api/backends/chat-completions/generate': 'openai',
    '/api/backends/text-completions/generate': 'textgenerationwebui',
    '/api/backends/kobold/generate': 'kobold',
    '/api/novelai/generate': 'novel',
};
const PAGE_ID = crypto.randomUUID?.() ?? String(Math.random()).slice(2);
const MAX_RETRY_MS = 10 * 60 * 1000;

const originalFetch = window.fetch.bind(window);
let pluginAvailable = true;
let lastGeneration = { type: 'normal', quiet: false };

const DEFAULT_SETTINGS = Object.freeze({
    general: {
        stopOnClose: false,
    },
    retry: {
        enabled: false,
        maxRetries: 3,
        delaySeconds: 1,
        reasoningOnlyIsEmpty: true,
        retryOnError: false,
    },
});

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    const settings = extensionSettings[SETTINGS_KEY] ?? (extensionSettings[SETTINGS_KEY] = {});
    settings.general = { ...DEFAULT_SETTINGS.general, ...(settings.general ?? {}) };
    settings.retry = { ...DEFAULT_SETTINGS.retry, ...(settings.retry ?? {}) };
    return settings;
}

// ---------------------------------------------------------------------------
// Page closing
// ---------------------------------------------------------------------------
// SillyTavern stops the running stream when the page unloads. That must not cancel the job on the server: the user
// may be switching devices (or iOS may have killed the page), and the result should stay recoverable. Only stopping
// while the page stays open (the Stop button, /stop, ...) cancels the job, unless "stop on close" is enabled.

let pageUnloading = false;

function onPageUnloading() {
    pageUnloading = true;
    // If the unload gets cancelled (e.g. the "leave site?" prompt), the page carries on normally.
    setTimeout(() => { pageUnloading = false; }, 10000);
    if (getSettings().general.stopOnClose) {
        pageJobs.forEach(job => cancelJob(job, { keepalive: true }));
    }
}

// SillyTavern's own beforeunload handler (registered earlier) stops the stream, and everything that follows from that
// can run before this listener. Decisions that depend on `pageUnloading` are therefore deferred with `afterEvent`.
window.addEventListener('beforeunload', onPageUnloading, { capture: true });
window.addEventListener('pagehide', onPageUnloading, { capture: true });

/** Retry options in the form the server plugin expects. */
function getRetryOptions() {
    const { retry } = getSettings();
    return {
        enabled: retry.enabled,
        maxRetries: retry.maxRetries,
        delayMs: Math.round(retry.delaySeconds * 1000),
        retryOnError: retry.retryOnError,
        reasoningCounts: !retry.reasoningOnlyIsEmpty,
    };
}

/**
 * Jobs started by this page.
 * @typedef {object} PageJob
 * @property {string} id Job ID
 * @property {number} clientStart Client time right before the job was started
 * @property {Array<[number, number]>} recv [client time, bytes received so far] for each chunk the client received
 * @property {HeadersInit} headers Request headers
 * @property {boolean} acked Whether the job was acknowledged to the server
 * @property {boolean} finished Whether the response was fully received
 * @property {boolean} cancelled Whether a cancel was sent
 * @type {PageJob[]}
 */
const pageJobs = [];

/** Tells the server this page has handled the job, so it isn't offered for recovery. */
/** Runs a callback after the current event (and the unload handlers it may be part of) has been fully dispatched. */
function afterEvent(callback) {
    setTimeout(callback, 0);
}

function ackJob(job) {
    if (job.acked) return;
    afterEvent(() => {
        // A closing page hasn't saved the result; leave it for recovery on the next page.
        if (job.acked || pageUnloading) return;
        job.acked = true;
        originalFetch(`${BASE}/jobs/${job.id}/ack`, { method: 'POST', headers: job.headers }).catch(() => { });
    });
}

/**
 * Cancels the job on the server (which also acknowledges it).
 * @param {PageJob} job
 * @param {object} [options]
 * @param {boolean} [options.keepalive] Let the request outlive the page
 */
function cancelJob(job, { keepalive = false } = {}) {
    // Not gated on `acked`: stopping a generation also ends it, which acknowledges the job right before this runs.
    if (job.cancelled || job.finished) return;
    job.cancelled = true;
    job.acked = true;
    originalFetch(`${BASE}/jobs/${job.id}/cancel`, { method: 'POST', headers: job.headers, keepalive }).catch(() => { });
}

class FatalJobError extends Error { }

function abortError() {
    return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Waits for a retry delay. While the page is hidden, waits until it becomes visible again instead.
 */
function waitForRetry(ms, signal) {
    return new Promise((resolve) => {
        let timer = null;
        const done = () => {
            clearTimeout(timer);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('online', done);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        const onVisible = () => { if (document.visibilityState === 'visible') done(); };
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('online', done);
        signal?.addEventListener('abort', done, { once: true });
        if (document.visibilityState === 'visible') timer = setTimeout(done, ms);
    });
}

function getTargetPath(input, init) {
    if ((init?.method ?? 'GET').toUpperCase() !== 'POST' || typeof init?.body !== 'string') return null;
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
    if (!raw) return null;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin) return null;
    return Object.hasOwn(TARGETS, url.pathname) ? url.pathname : null;
}

function getMeta() {
    const context = SillyTavern.getContext();
    const last = context.chat?.[context.chat.length - 1];
    const lastSwipeId = last?.swipe_id ?? 0;
    return {
        pageId: PAGE_ID,
        chatId: context.getCurrentChatId?.() ?? null,
        characterId: context.characterId ?? null,
        groupId: context.groupId ?? null,
        name: context.name2 ?? '',
        type: lastGeneration.type,
        quiet: lastGeneration.quiet,
        // Chat state when the request was sent, so a recovered reply can be put exactly where it belongs.
        chatLength: context.chat?.length ?? null,
        lastMesLength: typeof last?.mes === 'string' ? last.mes.length : null,
        lastSwipes: Array.isArray(last?.swipes) ? last.swipes.length : 1,
        lastSwipeId,
        lastSwipeEmpty: isPlaceholderText(Array.isArray(last?.swipes) ? last.swipes[lastSwipeId] : last?.mes),
    };
}

/** True for the text of a message SillyTavern created but never filled. */
function isPlaceholderText(text) {
    return ['', '...'].includes(String(text ?? '').trim());
}

async function resumableFetch(input, init, target) {
    const signal = init.signal;
    if (signal?.aborted) throw abortError();

    const headers = init.headers;
    const clientStart = Date.now();
    /** @type {Array<[number, number]>} */
    const recv = [];
    const retryOptions = getRetryOptions();
    const meta = getMeta();
    const wrapped = `{"target":${JSON.stringify(target)},"meta":${JSON.stringify(meta)},"options":${JSON.stringify({ retry: retryOptions })},"payload":${init.body}}`;
    const startResponse = await originalFetch(`${BASE}/start`, { method: 'POST', headers, body: wrapped, signal });

    if (startResponse.status === 404 && !startResponse.headers.get('content-type')?.includes('json')) {
        // Plugin is not installed / server plugins are disabled.
        pluginAvailable = false;
        console.warn('[resumable-gen] Server plugin not available, falling back to direct requests');
        return originalFetch(input, init);
    }
    if (!startResponse.ok) {
        return startResponse;
    }

    const { id } = await startResponse.json();
    /** @type {PageJob} */
    const pageJob = { id, clientStart, recv, headers, acked: false, finished: false, cancelled: false };
    pageJobs.push(pageJob);
    pageJobs.splice(0, Math.max(0, pageJobs.length - 20));
    if (retryOptions.enabled && !meta.quiet) watchRetries(pageJob);
    let received = 0;
    let finished = false;
    /** @type {AbortController|null} */
    let attachController = null;

    const onAbort = () => {
        attachController?.abort();
        if (finished) return;
        // If this abort comes from SillyTavern reacting to the page unloading, our listener has flagged it by then.
        afterEvent(() => {
            if (pageUnloading && !getSettings().general.stopOnClose) {
                console.info('[resumable-gen] Page is closing; leaving the generation running on the server');
                return;
            }
            cancelJob(pageJob, { keepalive: pageUnloading });
        });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    /** Attaches to the job at the current offset, retrying through network failures. */
    const attach = async () => {
        const startedAt = Date.now();
        let delay = 500;
        while (true) {
            if (signal?.aborted) throw abortError();
            attachController = new AbortController();
            try {
                const response = await originalFetch(`${BASE}/jobs/${id}/stream?offset=${received}`, {
                    headers,
                    cache: 'no-store',
                    signal: attachController.signal,
                });
                if (!response.headers.get('X-Resumable-Job')) {
                    throw new FatalJobError(`Generation job ${id} is no longer available (HTTP ${response.status})`);
                }
                return response;
            } catch (error) {
                if (signal?.aborted) throw abortError();
                if (error instanceof FatalJobError || Date.now() - startedAt > MAX_RETRY_MS) throw error;
                console.debug('[resumable-gen] Attach failed, retrying', error);
                await waitForRetry(delay, signal);
                delay = Math.min(delay * 2, 5000);
            }
        }
    };

    /** Checks whether the server-side job has really been fully received. */
    const isComplete = async () => {
        try {
            const response = await originalFetch(`${BASE}/jobs/${id}`, { headers, cache: 'no-store' });
            if (!response.ok) return true;
            const info = await response.json();
            return info.done && received >= info.size;
        } catch {
            return false;
        }
    };

    const first = await attach();
    let reader = first.body.getReader();

    const body = new ReadableStream({
        async pull(controller) {
            while (true) {
                try {
                    const { done, value } = await reader.read();
                    if (!done) {
                        received += value.byteLength;
                        recv.push([Date.now(), received]);
                        controller.enqueue(value);
                        return;
                    }
                    if (signal?.aborted) throw abortError();
                    if (await isComplete()) {
                        finished = true;
                        pageJob.finished = true;
                        signal?.removeEventListener('abort', onAbort);
                        ackJob(pageJob);
                        controller.close();
                        return;
                    }
                    // Connection ended cleanly but the job isn't complete; fall through to re-attach.
                } catch (error) {
                    if (signal?.aborted) {
                        controller.error(abortError());
                        return;
                    }
                    console.info('[resumable-gen] Stream interrupted, reconnecting at offset', received, error);
                }
                try {
                    reader = (await attach()).body.getReader();
                } catch (error) {
                    controller.error(error);
                    return;
                }
            }
        },
        cancel() {
            attachController?.abort();
        },
    });

    const responseHeaders = new Headers();
    const contentType = first.headers.get('content-type');
    if (contentType) responseHeaders.set('content-type', contentType);
    return new Response(body, { status: first.status, statusText: first.statusText, headers: responseHeaders });
}

window.fetch = async function (input, init) {
    let target = null;
    try {
        target = pluginAvailable ? getTargetPath(input, init) : null;
    } catch {
        target = null;
    }
    return target ? resumableFetch(input, init, target) : originalFetch(input, init);
};

// ---------------------------------------------------------------------------
// Empty response retries
// ---------------------------------------------------------------------------
// Retries happen on the server. The page polls the job while it runs and shows the progress under the message's
// token counter; the final count is kept in the message's extra data so it survives reloads and swipes.

const RETRY_POLL_MS = 1000;

/**
 * @typedef {object} RetryInfo
 * @property {number} retries Retries performed
 * @property {number} max Max retries allowed
 * @property {boolean} exhausted All attempts came back empty
 */

/**
 * Shows (or removes) the retry label under a message's token counter.
 * @param {Element|null} messageElement
 * @param {RetryInfo|null} info
 */
function renderRetryLabel(messageElement, info) {
    const wrapper = messageElement?.querySelector('.mesAvatarWrapper');
    if (!wrapper) return;
    let label = wrapper.querySelector('.resumable-gen-retry');
    if (!info || info.retries <= 0) {
        label?.remove();
        return;
    }
    if (!label) {
        label = document.createElement('div');
        label.className = 'resumable-gen-retry';
        const anchor = wrapper.querySelector('.tokenCounterDisplay') ?? wrapper.querySelector('.mes_timer');
        anchor ? anchor.after(label) : wrapper.append(label);
    }
    label.textContent = `自动重试 ${info.retries}/${info.max}`;
    label.classList.toggle('exhausted', !!info.exhausted);
    label.title = info.exhausted
        ? `已自动重试 ${info.retries} 次，回复仍为空`
        : `回复为空，已自动重试 ${info.retries} 次（最多 ${info.max} 次）`;
}

/** @returns {RetryInfo|null} */
function toRetryInfo(job) {
    if (!job || job.maxAttempts <= 1 || job.attempt <= 1) return null;
    return { retries: job.attempt - 1, max: job.maxAttempts - 1, exhausted: !!job.exhausted };
}

/** Renders retry labels for all rendered messages, from their saved data. */
function renderAllRetryLabels() {
    const { chat } = SillyTavern.getContext();
    for (const element of document.querySelectorAll('#chat .mes')) {
        const message = chat[Number(element.getAttribute('mesid'))];
        renderRetryLabel(element, message?.extra?.resumable_retry ?? null);
    }
}

/**
 * Polls a running job and shows its retry progress on the message being generated.
 * @param {PageJob} job
 */
async function watchRetries(job) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30 * 60 * 1000) {
        await new Promise(resolve => setTimeout(resolve, RETRY_POLL_MS));
        let info;
        try {
            const response = await originalFetch(`${BASE}/jobs/${job.id}`, { headers: job.headers, cache: 'no-store' });
            if (!response.ok) return;
            info = await response.json();
        } catch {
            continue;
        }
        const retry = toRetryInfo(info);
        if (retry) {
            // The message being streamed is the last one; skip if SillyTavern hasn't created it (non-streaming).
            const element = document.querySelector('#chat .mes.last_mes:not([is_user="true"])');
            renderRetryLabel(element, retry);
        }
        if (info.done) return;
    }
}

/**
 * Stores the final retry count of a generation on its message.
 * @param {number} messageId
 * @param {object} info Job info from the server
 */
function saveRetryInfo(messageId, info) {
    const message = SillyTavern.getContext().chat[messageId];
    if (!message) return;
    const retry = toRetryInfo(info);
    const extra = message.extra ?? (message.extra = {});
    if (retry) {
        extra.resumable_retry = retry;
    } else {
        delete extra.resumable_retry;
    }
    const swipeInfo = message.swipe_info?.[message.swipe_id ?? 0];
    if (swipeInfo) {
        swipeInfo.extra = swipeInfo.extra ?? {};
        if (retry) {
            swipeInfo.extra.resumable_retry = retry;
        } else {
            delete swipeInfo.extra.resumable_retry;
        }
    }
    renderRetryLabel(document.querySelector(`#chat .mes[mesid="${messageId}"]`), retry);
    if (retry?.exhausted) {
        toastr.warning(`已自动重试 ${retry.retries} 次，回复仍为空。`, 'Resumable Generation');
    }
}

// ---------------------------------------------------------------------------
// Generation timer correction
// ---------------------------------------------------------------------------
// SillyTavern times generations with the browser's wall clock. When the page was suspended and the stream resumed
// later, everything received after the resume gets the resume time. We map each client-side moment back to the byte
// offset received by then, and that offset to the time the server actually received it.

/** Minimum discrepancy (ms) before a timer gets corrected; smaller differences are just network latency. */
const TIMER_CORRECTION_THRESHOLD = 1000;

/**
 * Converts a client time into the corresponding "true" client time, based on when the server received the data
 * that the client had received by then.
 * @param {PageJob} job
 * @param {Array<[number, number]>} timeline [end byte offset, ms since job start] for each chunk the server received
 * @param {number} clientTime
 * @returns {number}
 */
function toTrueTime(job, timeline, clientTime) {
    let offset = job.recv[0]?.[1] ?? 0;
    for (const [time, bytes] of job.recv) {
        if (time > clientTime) break;
        offset = bytes;
    }
    const entry = timeline.find(([end]) => end >= offset) ?? timeline[timeline.length - 1];
    return job.clientStart + (entry?.[1] ?? 0);
}

/** Same output as SillyTavern's formatGenerationTimer (not exported). */
function formatTimer(started, finished, tokenCount, reasoningDuration, timeToFirstToken) {
    const dateFormat = 'HH:mm:ss D MMM YYYY';
    const start = moment(started);
    const finish = moment(finished);
    const seconds = finish.diff(start, 'seconds', true);
    const value = `${seconds.toFixed(1)}s`;
    const title = [
        `Generation queued: ${start.format(dateFormat)}`,
        `Reply received: ${finish.format(dateFormat)}`,
        `Time to generate: ${seconds} seconds`,
        timeToFirstToken ? `Time to first token: ${timeToFirstToken / 1000} seconds` : '',
        reasoningDuration > 0 ? `Time to think: ${reasoningDuration / 1000} seconds` : '',
        tokenCount > 0 ? `Token rate: ${Number(tokenCount / seconds).toFixed(3)} t/s` : '',
    ].filter(x => x).join('\n').trim();
    return { value, title };
}

/**
 * Updates a just-received message with data from the job that generated it: retry count and corrected timer.
 * @param {number} messageId
 */
async function onMessageReceived(messageId) {
    if (insertingRecovered) return;
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message || message.is_user || !message.gen_started || !message.gen_finished) return;

    const started = new Date(message.gen_started).getTime();
    const finished = new Date(message.gen_finished).getTime();
    // The last job started during this generation (tool calls can produce several; the last one ends it).
    const job = pageJobs.findLast(j => j.clientStart >= started - 1000 && j.clientStart <= finished);
    if (!job) return;

    const response = await originalFetch(`${BASE}/jobs/${job.id}?timeline=1`, { headers: job.headers, cache: 'no-store' });
    if (!response.ok) return;
    const info = await response.json();
    saveRetryInfo(messageId, info);
    correctGenerationTimer(messageId, job, info.timeline);
}

/**
 * @param {number} messageId
 * @param {PageJob} job
 * @param {Array<[number, number]>} timeline
 */
function correctGenerationTimer(messageId, job, timeline) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!Array.isArray(timeline) || timeline.length === 0 || job.recv.length === 0) return;

    const started = new Date(message.gen_started).getTime();
    const finished = new Date(message.gen_finished).getTime();

    // Time between the last received chunk and the message being finalized is local processing, keep it.
    const lastRecv = Math.min(finished, job.recv[job.recv.length - 1][0]);
    const trueFinished = toTrueTime(job, timeline, lastRecv) + (finished - lastRecv);
    if (finished - trueFinished < TIMER_CORRECTION_THRESHOLD) return;

    const extra = message.extra ?? (message.extra = {});
    message.gen_finished = new Date(trueFinished);

    if (extra.time_to_first_token > 0) {
        const trueFirst = toTrueTime(job, timeline, started + extra.time_to_first_token) - started;
        if (trueFirst >= 0 && trueFirst < extra.time_to_first_token) extra.time_to_first_token = trueFirst;
    }
    if (extra.reasoning_duration > 0) {
        const trueReasoning = toTrueTime(job, timeline, started + extra.reasoning_duration) - started;
        if (trueReasoning >= 0 && trueReasoning < extra.reasoning_duration) extra.reasoning_duration = trueReasoning;
    }

    const swipeInfo = message.swipe_info?.[message.swipe_id ?? 0];
    if (swipeInfo) {
        swipeInfo.gen_finished = message.gen_finished;
        swipeInfo.extra = { ...(swipeInfo.extra ?? {}), time_to_first_token: extra.time_to_first_token, reasoning_duration: extra.reasoning_duration };
    }

    const element = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    const timer = element?.querySelector('.mes_timer');
    if (timer) {
        const { value, title } = formatTimer(message.gen_started, message.gen_finished, extra.token_count, extra.reasoning_duration, extra.time_to_first_token);
        timer.textContent = value;
        timer.setAttribute('title', title);
    }
    if (element && extra.reasoning_duration > 0) {
        context.updateMessageBlock(messageId, message, { rerenderMessage: false });
    }
    console.info(`[resumable-gen] Corrected generation timer of message ${messageId}: ${((finished - started) / 1000).toFixed(1)}s -> ${((trueFinished - started) / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
// Server plugin check
// ---------------------------------------------------------------------------

function showSetupNotice(reason) {
    try {
        if (localStorage.getItem(NOTICE_DISMISS_KEY) === reason) return;
    } catch {
        // Storage unavailable; show the notice anyway.
    }
    const messages = {
        missing: '未检测到 Resumable Generation 服务端插件，断线重连功能未生效（生成会照常进行，只是不能续传）。需要把本仓库克隆到酒馆的 plugins 目录，并在 config.yaml 中设置 enableServerPlugins: true 后重启。',
        mismatch: 'Resumable Generation 的前端扩展和服务端插件版本不匹配，断线重连功能已暂时关闭。请同时更新两者（服务端插件会在酒馆重启时自动更新）。',
    };
    const toast = toastr.warning(`${messages[reason]}<br><a href="${README_URL}" target="_blank" rel="noopener">查看安装说明</a> · <a href="#" class="resumable-gen-dismiss">不再提示</a>`, 'Resumable Generation', {
        timeOut: 0,
        extendedTimeOut: 0,
        closeButton: true,
        escapeHtml: false,
        tapToDismiss: false,
    });
    toast?.find?.('.resumable-gen-dismiss')?.on('click', (e) => {
        e.preventDefault();
        try {
            localStorage.setItem(NOTICE_DISMISS_KEY, reason);
        } catch {
            // Ignore
        }
        toastr.clear(toast);
    });
}

async function checkServerPlugin() {
    try {
        const response = await originalFetch(`${BASE}/info`, { headers: SillyTavern.getContext().getRequestHeaders(), cache: 'no-store' });
        if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
            pluginAvailable = false;
            showSetupNotice('missing');
            return;
        }
        const info = await response.json();
        if (info.protocol !== PROTOCOL) {
            pluginAvailable = false;
            console.warn(`[resumable-gen] Protocol mismatch: client ${PROTOCOL}, server ${info.protocol} (v${info.version})`);
            showSetupNotice('mismatch');
            return;
        }
        console.info(`[resumable-gen] Server plugin v${info.version} detected`);
    } catch (error) {
        // Network hiccup: keep trying through the plugin, start requests fall back on their own if it's missing.
        console.warn('[resumable-gen] Could not check server plugin', error);
    }
}

// ---------------------------------------------------------------------------
// Recovery after the page was reloaded / killed
// ---------------------------------------------------------------------------

function parseRecoveredText(job, raw) {
    const api = TARGETS[job.target];
    const state = { reasoning: '', images: [], signature: '', toolSignatures: {} };
    let text = '';

    if (!job.meta?.stream) {
        try {
            text = extractMessageFromData(JSON.parse(raw), api) || '';
        } catch {
            text = raw;
        }
        return { text, reasoning: '' };
    }

    for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let parsed;
        try {
            parsed = JSON.parse(data);
        } catch {
            continue;
        }
        if (api === 'openai') {
            text += getStreamingReply(parsed, state, { chatCompletionSource: job.meta?.source, overrideShowThoughts: true }) || '';
        } else {
            const piece = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.text ?? parsed?.content ?? parsed?.token?.text ?? parsed?.token ?? parsed?.text ?? '';
            text += typeof piece === 'string' ? piece : '';
        }
    }
    return { text, reasoning: state.reasoning };
}

async function fetchJobText(job) {
    const response = await originalFetch(`${BASE}/jobs/${job.id}/stream?offset=0`, { headers: SillyTavern.getContext().getRequestHeaders(), cache: 'no-store' });
    return parseRecoveredText(job, await response.text());
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

let recovering = false;
let recheckRequested = false;
const skippedThisSession = new Set();
/** @type {Map<string, any>} Running jobs of other pages in the current chat, being watched until they finish */
const watchedForeignJobs = new Map();
const FOREIGN_POLL_MS = 2000;
/** How long to wait after a job finished before offering it, in case the page that started it acknowledges it. */
const ACK_GRACE_MS = 5000;

/** True if the job belongs to this chat, wasn't started by this page and is a regular (non-quiet) generation. */
function isForeignChatJob(job, chatId) {
    return job.meta?.pageId !== PAGE_ID && !job.meta?.quiet && !!job.meta?.chatId && job.meta.chatId === chatId;
}

function describeForeignJob(job) {
    const seconds = Math.max(0, Math.round((Date.now() - job.createdAt) / 1000));
    const retry = toRetryInfo(job);
    const retryText = retry ? `，自动重试 ${retry.retries}/${retry.max}` : '';
    return `另一个页面发起的生成（${escapeHtml(job.meta?.name ?? '')}）仍在服务器上进行，已 ${seconds} 秒${retryText}。完成后会在这里提示恢复。`;
}

/**
 * Shows a notice for a generation started by another page that is still running, and offers recovery once it
 * finishes.
 * @param {any} job Job info from the server
 */
async function watchForeignJob(job) {
    if (watchedForeignJobs.has(job.id)) return;
    watchedForeignJobs.set(job.id, job);
    const toast = toastr.info(describeForeignJob(job), 'Resumable Generation', {
        timeOut: 0,
        extendedTimeOut: 0,
        closeButton: true,
        escapeHtml: false,
        tapToDismiss: false,
    });
    const message = toast?.find?.('.toast-message');
    try {
        while (true) {
            await new Promise(resolve => setTimeout(resolve, FOREIGN_POLL_MS));
            const response = await originalFetch(`${BASE}/jobs/${job.id}`, { headers: SillyTavern.getContext().getRequestHeaders(), cache: 'no-store' });
            if (!response.ok) return;
            job = await response.json();
            if (job.cancelled) return;
            // The original page is alive and finished it; it has saved the reply to the chat, which this page
            // doesn't have yet.
            if (job.acked) {
                if (job.done && job.meta?.chatId === SillyTavern.getContext().getCurrentChatId?.()) {
                    toastr.info('另一个页面已完成这次生成并保存了回复。点此刷新聊天以显示新消息。', 'Resumable Generation', {
                        timeOut: 15000,
                        onclick: () => SillyTavern.getContext().reloadCurrentChat(),
                    });
                }
                return;
            }
            // Stop watching when the user leaves the chat; coming back checks again.
            if (job.meta?.chatId !== SillyTavern.getContext().getCurrentChatId?.()) return;
            if (job.done) {
                // If the original page is still alive it acknowledges the job right after finishing; give it time,
                // so the result isn't offered here too.
                await new Promise(resolve => setTimeout(resolve, ACK_GRACE_MS));
                checkForRecoverableJobs();
                return;
            }
            message?.html(describeForeignJob(job));
        }
    } catch (error) {
        console.warn('[resumable-gen] Watching job failed', error);
    } finally {
        watchedForeignJobs.delete(job.id);
        toast && toastr.clear(toast, { force: true });
    }
}

/**
 * Where a recovered reply goes.
 * @typedef {object} Placement
 * @property {'new'|'replace'|'swipe'|'append'|'input'} mode
 *   new: add a message; replace: replace the last message's current swipe; swipe: put into swipe `swipeIndex` of the
 *   last message (adding it if needed); append: append to the last message; input: put into the input box
 * @property {number} [swipeIndex] For 'swipe'
 * @property {number} [baseLength] For 'append': length of the last message before the generation
 * @property {string} description Shown to the user
 */

/**
 * Works out where a recovered reply belongs, from the generation type and the chat state recorded when it was sent.
 * @param {any} job Job info from the server
 * @returns {Placement}
 */
function planPlacement(job) {
    const { chat } = SillyTavern.getContext();
    const meta = job.meta ?? {};
    const type = meta.type ?? 'normal';
    const last = chat[chat.length - 1];
    const lastIsBot = !!last && !last.is_user && !last.is_system;
    const recorded = Number.isInteger(meta.chatLength);
    const changedNote = '聊天在生成期间有变化，';

    if (type === 'impersonate') {
        return { mode: 'input', description: '将填入输入框（这是一次"代拟"生成）。' };
    }

    if (type === 'continue' || type === 'swipe') {
        // These extend the last message, which must still be the same one.
        const sameChat = recorded ? chat.length === meta.chatLength : true;
        if (lastIsBot && sameChat) {
            if (type === 'continue') {
                const baseLength = Number.isInteger(meta.lastMesLength) ? meta.lastMesLength : String(last.mes ?? '').length;
                return { mode: 'append', baseLength, description: '将接在最后一条消息的正文后面（这是一次"继续"生成）。' };
            }
            // SillyTavern may or may not have created the new swipe slot before sending the request.
            const swipeIndex = recorded ? (meta.lastSwipeEmpty ? meta.lastSwipeId : meta.lastSwipes) : (Array.isArray(last.swipes) ? last.swipes.length : 1);
            return { mode: 'swipe', swipeIndex, description: '将作为最后一条消息的新滑动（这是一次"滑动"生成）。' };
        }
        return { mode: 'new', description: `${changedNote}将作为新消息插入。` };
    }

    if (recorded) {
        // The page that started it saves the reply as a new message at index chatLength when streaming begins;
        // if that (possibly partial) message is there, replace it.
        if (chat.length === meta.chatLength + 1 && lastIsBot) {
            return { mode: 'replace', description: '将替换生成中断时留下的那条回复。' };
        }
        if (chat.length === meta.chatLength) {
            return { mode: 'new', description: '将作为新消息插入。' };
        }
        return { mode: 'new', description: `${changedNote}将作为新消息插入到最后。` };
    }

    // Jobs from older versions don't have the chat state.
    if (lastIsBot && isPlaceholderText(last.mes)) {
        return { mode: 'replace', description: '将替换最后一条空回复。' };
    }
    return { mode: 'new', description: '将作为新消息插入。' };
}

/**
 * Puts a recovered reply into the chat the way SillyTavern does for a received message, firing the same events so
 * other extensions (e.g. ones rendering HTML in messages) process it.
 * @param {any} job Job info from the server
 * @param {string} text Reply text
 * @param {string} reasoning Reasoning text
 * @param {Placement} placement Where it goes
 */
async function insertRecoveredReply(job, text, reasoning, placement) {
    insertingRecovered = true;
    try {
        await insertRecoveredReplyInner(job, text, reasoning, placement);
    } finally {
        insertingRecovered = false;
    }
}

/** True while a recovered reply is being inserted, so its events aren't mistaken for this page's generations. */
let insertingRecovered = false;

/**
 * @param {any} job
 * @param {string} text
 * @param {string} reasoning
 * @param {Placement} placement
 */
async function insertRecoveredReplyInner(job, text, reasoning, placement) {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

    if (placement.mode === 'input') {
        const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await eventSource.emit(eventTypes.IMPERSONATE_READY, text);
        return;
    }

    const retry = toRetryInfo(job);
    // Server clock; close enough to the client's for a timer.
    const genStarted = new Date(job.createdAt);
    const genFinished = new Date(job.finishedAt || Date.now());
    const sendDate = getMessageTimeStamp();
    // Stale values from a placeholder must not survive.
    const extra = {
        reasoning: reasoning || '',
        reasoning_duration: undefined,
        time_to_first_token: undefined,
        token_count: undefined,
        resumable_retry: retry ?? undefined,
    };
    const swipeInfo = () => ({ send_date: sendDate, gen_started: genStarted, gen_finished: genFinished, extra: { ...extra } });

    if (placement.mode === 'new') {
        const message = {
            name: job.meta?.name || context.name2,
            is_user: false,
            is_system: false,
            send_date: sendDate,
            gen_started: genStarted,
            gen_finished: genFinished,
            mes: text,
            extra: { ...extra },
            swipes: [text],
            swipe_id: 0,
            swipe_info: [swipeInfo()],
        };
        context.chat.push(message);
        const messageId = context.chat.length - 1;
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, messageId, 'normal');
        context.addOneMessage(message);
        await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, messageId, 'normal');
        await context.saveChat();
        renderAllRetryLabels();
        return;
    }

    const messageId = context.chat.length - 1;
    const message = context.chat[messageId];
    if (!Array.isArray(message.swipes)) {
        message.swipes = [message.mes];
        message.swipe_info = [{ send_date: message.send_date, gen_started: message.gen_started, gen_finished: message.gen_finished, extra: structuredClone(message.extra ?? {}) }];
        message.swipe_id = 0;
    }
    message.swipe_info = message.swipe_info ?? [];

    let eventType = 'normal';
    if (placement.mode === 'append') {
        eventType = 'continue';
        const swipeId = message.swipe_id ?? 0;
        // Drop whatever partial continuation the original page saved, then add the full one.
        const newText = String(message.mes ?? '').slice(0, placement.baseLength) + text;
        message.mes = newText;
        message.swipes[swipeId] = newText;
        const info = message.swipe_info[swipeId] ?? (message.swipe_info[swipeId] = swipeInfo());
        Object.assign(info, { gen_finished: genFinished });
        message.gen_finished = genFinished;
        message.extra = { ...(message.extra ?? {}), resumable_retry: retry ?? undefined };
        info.extra = { ...(info.extra ?? {}), resumable_retry: retry ?? undefined };
    } else {
        let swipeId;
        if (placement.mode === 'swipe') {
            eventType = 'swipe';
            swipeId = Math.min(placement.swipeIndex ?? message.swipes.length, message.swipes.length);
        } else {
            swipeId = message.swipe_id ?? 0;
        }
        message.swipes[swipeId] = text;
        message.swipe_info[swipeId] = { ...(message.swipe_info[swipeId] ?? {}), ...swipeInfo(), extra: { ...(message.swipe_info[swipeId]?.extra ?? {}), ...extra } };
        message.swipe_id = swipeId;
        message.mes = text;
        message.send_date = sendDate;
        message.gen_started = genStarted;
        message.gen_finished = genFinished;
        message.extra = { ...(message.extra ?? {}), ...extra };
    }

    await eventSource.emit(eventTypes.MESSAGE_RECEIVED, messageId, eventType);
    await context.saveChat();
    await context.reloadCurrentChat();
    await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, messageId, eventType);
    renderAllRetryLabels();
}

async function checkForRecoverableJobs() {
    if (!pluginAvailable) return;
    if (recovering) {
        // A popup is open or a check is running; look again once it's done so nothing that finished meanwhile is missed.
        recheckRequested = true;
        return;
    }
    recovering = true;
    try {
        const context = SillyTavern.getContext();
        const headers = context.getRequestHeaders();
        const response = await originalFetch(`${BASE}/jobs`, { headers, cache: 'no-store' });
        if (!response.ok) {
            if (response.status === 404) pluginAvailable = false;
            return;
        }
        const chatId = context.getCurrentChatId?.();
        const allJobs = await response.json();

        allJobs
            .filter(j => !j.done && !j.cancelled && !j.acked && isForeignChatJob(j, chatId))
            .forEach(j => watchForeignJob(j));

        const jobs = allJobs
            .filter(j => j.done && !j.acked && !j.cancelled && j.status >= 200 && j.status < 300)
            .filter(j => !skippedThisSession.has(j.id))
            .filter(j => isForeignChatJob(j, chatId))
            .sort((a, b) => a.createdAt - b.createdAt);

        for (const job of jobs) {
            const { text, reasoning } = await fetchJobText(job);
            const ack = () => originalFetch(`${BASE}/jobs/${job.id}/ack`, { method: 'POST', headers }).catch(() => { });
            if (!text.trim()) {
                await ack();
                continue;
            }

            const time = new Date(job.createdAt).toLocaleTimeString();
            const placement = planPlacement(job);
            const html = `<h3>找到一条后台完成的生成（${escapeHtml(job.meta?.name ?? '')}，${time}）</h3>
                <div style="text-align:left;max-height:50vh;overflow:auto;white-space:pre-wrap;border:1px solid var(--SmartThemeBorderColor);padding:8px;border-radius:6px;">${escapeHtml(text)}</div>
                <small style="display:block;margin-top:6px;opacity:0.8;">${escapeHtml(placement.description)}</small>`;

            const result = await context.callGenericPopup(html, context.POPUP_TYPE.CONFIRM, '', {
                okButton: '恢复',
                cancelButton: '丢弃',
                customButtons: [{ text: '稍后再说', result: 3 }],
                wide: true,
                allowVerticalScrolling: true,
            });

            if (result === 3 || result === null || result === undefined) {
                skippedThisSession.add(job.id);
                continue;
            }

            if (result === 1) {
                // The chat may have changed while the popup was open.
                await insertRecoveredReply(job, text, reasoning, planPlacement(job));
            }

            await ack();
        }
    } catch (error) {
        console.error('[resumable-gen] Recovery check failed', error);
    } finally {
        recovering = false;
        if (recheckRequested) {
            recheckRequested = false;
            setTimeout(checkForRecoverableJobs, 0);
        }
    }
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

function initSettingsUi() {
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container) return;
    const html = `
        <div class="resumable-gen-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Resumable Generation</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label" for="resumable_gen_stop_on_close">
                        <input type="checkbox" id="resumable_gen_stop_on_close">
                        <span>关闭页面时停止生成</span>
                    </label>
                    <small class="resumable-gen-hint">默认关闭：关掉或刷新页面后，生成仍会在服务器上跑完，下次在任意设备打开这个聊天都可以恢复。只有点"停止"按钮才会取消。开启后，关闭页面会尽量通知服务器停止（iOS 在后台杀掉页面时可能来不及通知）。</small>
                    <hr>
                    <label class="checkbox_label" for="resumable_gen_retry_enabled">
                        <input type="checkbox" id="resumable_gen_retry_enabled">
                        <span>空回复时自动重试</span>
                    </label>
                    <small class="resumable-gen-hint">在服务器上判断回复是否为空（例如被审查过滤），为空就重新请求。重试进度显示在消息左侧的 token 数下面。开启后，在出现正文之前不会向页面输出任何内容。</small>
                    <div class="resumable-gen-row">
                        <label for="resumable_gen_retry_max">最大重试次数</label>
                        <input type="number" id="resumable_gen_retry_max" class="text_pole" min="1" max="10" step="1">
                    </div>
                    <div class="resumable-gen-row">
                        <label for="resumable_gen_retry_delay">重试间隔（秒）</label>
                        <input type="number" id="resumable_gen_retry_delay" class="text_pole" min="0" max="60" step="0.5">
                    </div>
                    <label class="checkbox_label" for="resumable_gen_retry_reasoning">
                        <input type="checkbox" id="resumable_gen_retry_reasoning">
                        <span>只有思考、没有正文也算空回复</span>
                    </label>
                    <small class="resumable-gen-hint">关闭后，思考内容一出现就开始显示，但"思考完后正文被拦截"的情况就无法重试了。</small>
                    <label class="checkbox_label" for="resumable_gen_retry_error">
                        <input type="checkbox" id="resumable_gen_retry_error">
                        <span>上游报错（HTTP 错误、连接失败）时也重试</span>
                    </label>
                </div>
            </div>
        </div>`;
    container.insertAdjacentHTML('beforeend', html);

    const save = () => SillyTavern.getContext().saveSettingsDebounced();
    const bindCheckbox = (id, section, key) => {
        const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
        input.checked = !!getSettings()[section][key];
        input.addEventListener('input', () => { getSettings()[section][key] = input.checked; save(); });
    };
    const bindNumber = (id, section, key, min, max) => {
        const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
        input.value = String(getSettings()[section][key]);
        input.addEventListener('input', () => {
            const value = Number(input.value);
            if (!Number.isFinite(value)) return;
            getSettings()[section][key] = Math.min(max, Math.max(min, value));
            save();
        });
    };
    bindCheckbox('resumable_gen_stop_on_close', 'general', 'stopOnClose');
    bindCheckbox('resumable_gen_retry_enabled', 'retry', 'enabled');
    bindNumber('resumable_gen_retry_max', 'retry', 'maxRetries', 1, 10);
    bindNumber('resumable_gen_retry_delay', 'retry', 'delaySeconds', 0, 60);
    bindCheckbox('resumable_gen_retry_reasoning', 'retry', 'reasoningOnlyIsEmpty');
    bindCheckbox('resumable_gen_retry_error', 'retry', 'retryOnError');
}

(function initResumableGeneration() {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.MESSAGE_RECEIVED, async (messageId) => {
        try {
            await onMessageReceived(Number(messageId));
        } catch (error) {
            console.warn('[resumable-gen] Updating received message failed', error);
        }
    });
    // Re-render retry labels whenever messages are (re)drawn.
    const rerender = () => setTimeout(renderAllRetryLabels, 0);
    for (const event of [eventTypes.CHAT_CHANGED, eventTypes.MORE_MESSAGES_LOADED, eventTypes.MESSAGE_SWIPED, eventTypes.MESSAGE_UPDATED, eventTypes.CHARACTER_MESSAGE_RENDERED, eventTypes.MESSAGE_DELETED]) {
        if (event) eventSource.on(event, rerender);
    }
    initSettingsUi();
    // SillyTavern may stop reading a stream at [DONE] before it technically ends, so acknowledge everything this
    // page started once a generation is over. The page is alive and has handled them.
    eventSource.on(eventTypes.GENERATION_ENDED, () => pageJobs.forEach(ackJob));
    eventSource.on(eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
        if (dryRun) return;
        lastGeneration = { type: type ?? 'normal', quiet: type === 'quiet' && !options?.quietToLoud };
    });
    const pluginCheck = checkServerPlugin();
    eventSource.on(eventTypes.APP_READY, async () => {
        await pluginCheck;
        setTimeout(checkForRecoverableJobs, 1500);
    });
    eventSource.on(eventTypes.CHAT_CHANGED, () => setTimeout(checkForRecoverableJobs, 1500));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') setTimeout(checkForRecoverableJobs, 1500);
    });
})();
