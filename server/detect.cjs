/**
 * Detects whether a generation response contains an actual reply, so empty (e.g. filtered) responses can be retried.
 *
 * Handles SSE streams and plain JSON bodies of the formats SillyTavern's generate endpoints pass through:
 * OpenAI-compatible, Claude, Gemini, and common text completion backends. Anything that isn't recognized counts as
 * content, so an unknown format never triggers a retry.
 */

/**
 * @typedef {'content'|'empty'|'error'} Verdict
 */

function textOf(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(x => (typeof x === 'string' ? x : x?.text ?? '')).join('');
    return '';
}

function hasText(value) {
    return textOf(value).trim().length > 0;
}

/**
 * Classifies a single parsed event or response body.
 * @param {any} data Parsed JSON
 * @param {boolean} reasoningCounts Whether reasoning without reply text counts as content
 * @returns {Verdict}
 */
function classify(data, reasoningCounts) {
    if (!data || typeof data !== 'object') return 'content';
    if (data.error) return 'error';

    // OpenAI-compatible (chat and text completions)
    if (Array.isArray(data.choices)) {
        for (const choice of data.choices) {
            const delta = choice?.delta ?? choice?.message ?? {};
            if (hasText(delta.content) || hasText(choice?.text)) return 'content';
            if (delta.tool_calls?.length || delta.function_call) return 'content';
            if (reasoningCounts && (hasText(delta.reasoning_content) || hasText(delta.reasoning))) return 'content';
        }
        return 'empty';
    }

    // Claude
    if (typeof data.type === 'string' && (data.type.startsWith('message') || data.type.startsWith('content_block') || data.type === 'ping')) {
        if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') return 'content';
        if (data.type === 'content_block_delta') {
            const delta = data.delta ?? {};
            if (delta.type === 'text_delta' && hasText(delta.text)) return 'content';
            if (delta.type === 'input_json_delta') return 'content';
            if (reasoningCounts && delta.type === 'thinking_delta' && hasText(delta.thinking)) return 'content';
        }
        if (data.type === 'message' && Array.isArray(data.content)) {
            for (const block of data.content) {
                if (block?.type === 'text' && hasText(block.text)) return 'content';
                if (block?.type === 'tool_use') return 'content';
                if (reasoningCounts && block?.type === 'thinking' && hasText(block.thinking)) return 'content';
            }
        }
        return 'empty';
    }

    // Gemini
    if (Array.isArray(data.candidates) || data.promptFeedback) {
        for (const candidate of data.candidates ?? []) {
            for (const part of candidate?.content?.parts ?? []) {
                if (part?.functionCall || part?.inlineData) return 'content';
                if (hasText(part?.text) && (!part.thought || reasoningCounts)) return 'content';
            }
        }
        return 'empty';
    }

    // Text completion backends
    if ('token' in data) return hasText(typeof data.token === 'string' ? data.token : data.token?.text) ? 'content' : 'empty';
    if (Array.isArray(data.results)) return data.results.some(x => hasText(x?.text)) ? 'content' : 'empty';
    if ('output' in data) return hasText(data.output) ? 'content' : 'empty';
    if ('content' in data && typeof data.content === 'string') return hasText(data.content) ? 'content' : 'empty';
    if ('response' in data && typeof data.response === 'string') return hasText(data.response) ? 'content' : 'empty';

    return 'content';
}

class ContentDetector {
    /**
     * @param {object} options
     * @param {boolean} options.reasoningCounts Whether reasoning without reply text counts as content
     */
    constructor({ reasoningCounts }) {
        this.reasoningCounts = reasoningCounts;
        this.buffer = '';
        this.found = false;
        this.sawError = false;
        this.decoder = new TextDecoder();
    }

    #line(line) {
        line = line.trim();
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let verdict;
        try {
            verdict = classify(JSON.parse(data), this.reasoningCounts);
        } catch {
            verdict = 'content';
        }
        if (verdict === 'content') this.found = true;
        if (verdict === 'error') this.sawError = true;
    }

    /**
     * Feeds a chunk of a streaming response.
     * @param {Buffer} chunk
     * @returns {boolean} True once content was found
     */
    feed(chunk) {
        if (this.found) return true;
        this.buffer += this.decoder.decode(chunk, { stream: true });

        // Decide once whether this is an SSE stream or a plain body, from its first characters.
        if (this.mode === undefined) {
            const start = this.buffer.trimStart();
            if (/^(data:|event:|id:|retry:|:)/.test(start)) {
                this.mode = 'sse';
            } else if (start.length >= 6 || (start && !['data:', 'event:', 'id:', 'retry:'].some(x => x.startsWith(start)))) {
                this.mode = 'body';
            } else {
                return false;
            }
        }

        // A plain body is only judged as a whole at the end.
        if (this.mode === 'body') return false;

        let index;
        while (!this.found && (index = this.buffer.indexOf('\n')) >= 0) {
            this.#line(this.buffer.slice(0, index));
            this.buffer = this.buffer.slice(index + 1);
        }
        return this.found;
    }

    /**
     * Judges the complete response.
     * @returns {Verdict}
     */
    finish() {
        this.buffer += this.decoder.decode();
        if (this.mode === 'sse' && !this.found && this.buffer) this.#line(this.buffer);
        if (this.found) return 'content';
        if (this.mode === 'sse') return this.sawError ? 'error' : 'empty';
        const body = this.buffer.trim();
        if (!body) return 'empty';
        try {
            return classify(JSON.parse(body), this.reasoningCounts);
        } catch {
            return 'content';
        }
    }
}

module.exports = { ContentDetector, classify };
