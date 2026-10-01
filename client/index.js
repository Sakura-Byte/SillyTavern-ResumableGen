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
const PROTOCOL = 1;
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
    const wrapped = `{"target":${JSON.stringify(target)},"meta":${JSON.stringify(getMeta())},"payload":${init.body}}`;
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
    let received = 0;
    let finished = false;
    /** @type {AbortController|null} */
    let attachController = null;

    const ack = () => originalFetch(`${BASE}/jobs/${id}/ack`, { method: 'POST', headers }).catch(() => { });
    const onAbort = () => {
        attachController?.abort();
        if (!finished) originalFetch(`${BASE}/jobs/${id}/cancel`, { method: 'POST', headers }).catch(() => { });
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
                        controller.enqueue(value);
                        return;
                    }
                    if (signal?.aborted) throw abortError();
                    if (await isComplete()) {
                        finished = true;
                        signal?.removeEventListener('abort', onAbort);
                        ack();
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
const skippedThisSession = new Set();

async function checkForRecoverableJobs() {
    if (recovering || !pluginAvailable) return;
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
        const jobs = (await response.json())
            .filter(j => j.done && !j.acked && !j.cancelled && j.meta?.pageId !== PAGE_ID && j.status >= 200 && j.status < 300)
            .filter(j => !skippedThisSession.has(j.id))
            .filter(j => !j.meta?.quiet && j.meta?.chatId && j.meta.chatId === chatId)
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
                    extra: reasoning ? { reasoning } : {},
                };
                context.chat.push(message);
                context.addOneMessage(message);
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
                message.swipe_info.push({ send_date: getMessageTimeStamp(), extra: reasoning ? { reasoning } : {} });
                message.swipe_id = message.swipes.length - 1;
                message.mes = text;
                message.extra = { ...(message.extra ?? {}), reasoning: reasoning || undefined };
                await context.saveChat();
                await context.reloadCurrentChat();
            }

            await ack();
        }
    } catch (error) {
        console.error('[resumable-gen] Recovery check failed', error);
    } finally {
        recovering = false;
    }
}

(function initResumableGeneration() {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
        if (dryRun) return;
        lastGeneration = { type: type ?? 'normal', quiet: type === 'quiet' && !options?.quietToLoud };
    });
    eventSource.on(eventTypes.APP_READY, async () => {
        await checkServerPlugin();
        setTimeout(checkForRecoverableJobs, 1500);
    });
    eventSource.on(eventTypes.CHAT_CHANGED, () => setTimeout(checkForRecoverableJobs, 1500));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') setTimeout(checkForRecoverableJobs, 1500);
    });
})();
