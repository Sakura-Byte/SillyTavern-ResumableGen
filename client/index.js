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
    settings.retry = { ...DEFAULT_SETTINGS.retry, ...(settings.retry ?? {}) };
    return settings;
}

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
 * @type {PageJob[]}
 */
const pageJobs = [];

/** Tells the server this page has handled the job, so it isn't offered for recovery. */
function ackJob(job) {
    if (job.acked) return;
    job.acked = true;
    originalFetch(`${BASE}/jobs/${job.id}/ack`, { method: 'POST', headers: job.headers }).catch(() => { });
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
    return {
        pageId: PAGE_ID,
        chatId: context.getCurrentChatId?.() ?? null,
        characterId: context.characterId ?? null,
        groupId: context.groupId ?? null,
        name: context.name2 ?? '',
        type: lastGeneration.type,
        quiet: lastGeneration.quiet,
    };
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
    const pageJob = { id, clientStart, recv, headers, acked: false };
    pageJobs.push(pageJob);
    pageJobs.splice(0, Math.max(0, pageJobs.length - 20));
    if (retryOptions.enabled && !meta.quiet) watchRetries(pageJob);
    let received = 0;
    let finished = false;
    /** @type {AbortController|null} */
    let attachController = null;

    const onAbort = () => {
        attachController?.abort();
        if (!finished) {
            pageJob.acked = true; // Cancelling acknowledges it server-side
            originalFetch(`${BASE}/jobs/${id}/cancel`, { method: 'POST', headers }).catch(() => { });
        }
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
            const html = `<h3>找到一条后台完成的生成（${escapeHtml(job.meta?.name ?? '')}，${time}）</h3>
                <div style="text-align:left;max-height:50vh;overflow:auto;white-space:pre-wrap;border:1px solid var(--SmartThemeBorderColor);padding:8px;border-radius:6px;">${escapeHtml(text)}</div>`;
            const lastMessage = context.chat[context.chat.length - 1];
            const canSwipe = lastMessage && !lastMessage.is_user && !lastMessage.is_system;
            const customButtons = [{ text: '稍后再说', result: 3 }];
            if (canSwipe) customButtons.unshift({ text: '添加为最后一条的新滑动', result: 2 });

            const result = await context.callGenericPopup(html, context.POPUP_TYPE.CONFIRM, '', {
                okButton: '作为新消息插入',
                cancelButton: '丢弃',
                customButtons,
                wide: true,
                allowVerticalScrolling: true,
            });

            if (result === 3 || result === null || result === undefined) {
                skippedThisSession.add(job.id);
                continue;
            }

            if (result === 1) {
                const message = {
                    name: job.meta?.name || context.name2,
                    is_user: false,
                    is_system: false,
                    send_date: getMessageTimeStamp(),
                    mes: text,
                    extra: { ...(reasoning ? { reasoning } : {}), ...(toRetryInfo(job) ? { resumable_retry: toRetryInfo(job) } : {}) },
                };
                context.chat.push(message);
                context.addOneMessage(message);
                renderAllRetryLabels();
                await context.saveChat();
            } else if (result === 2 && canSwipe) {
                const message = context.chat[context.chat.length - 1];
                if (!Array.isArray(message.swipes)) {
                    message.swipes = [message.mes];
                    message.swipe_info = [{ send_date: message.send_date, extra: structuredClone(message.extra ?? {}) }];
                    message.swipe_id = 0;
                }
                message.swipes.push(text);
                message.swipe_info = message.swipe_info ?? [];
                const swipeExtra = { ...(reasoning ? { reasoning } : {}), ...(toRetryInfo(job) ? { resumable_retry: toRetryInfo(job) } : {}) };
                message.swipe_info.push({ send_date: getMessageTimeStamp(), extra: swipeExtra });
                message.swipe_id = message.swipes.length - 1;
                message.mes = text;
                message.extra = { ...(message.extra ?? {}), reasoning: reasoning || undefined, resumable_retry: swipeExtra.resumable_retry };
                await context.saveChat();
                await context.reloadCurrentChat();
                renderAllRetryLabels();
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
    const { retry } = getSettings();
    const html = `
        <div class="resumable-gen-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Resumable Generation</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
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
    const bindCheckbox = (id, key) => {
        const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
        input.checked = !!retry[key];
        input.addEventListener('input', () => { getSettings().retry[key] = input.checked; save(); });
    };
    const bindNumber = (id, key, min, max) => {
        const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
        input.value = String(retry[key]);
        input.addEventListener('input', () => {
            const value = Number(input.value);
            if (!Number.isFinite(value)) return;
            getSettings().retry[key] = Math.min(max, Math.max(min, value));
            save();
        });
    };
    bindCheckbox('resumable_gen_retry_enabled', 'enabled');
    bindNumber('resumable_gen_retry_max', 'maxRetries', 1, 10);
    bindNumber('resumable_gen_retry_delay', 'delaySeconds', 0, 60);
    bindCheckbox('resumable_gen_retry_reasoning', 'reasoningOnlyIsEmpty');
    bindCheckbox('resumable_gen_retry_error', 'retryOnError');
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
