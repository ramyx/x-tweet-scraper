import { Agent, ProxyAgent, request as undiciRequest, type Dispatcher } from 'undici';

/**
 * HTTP transport. No browser engine anywhere (assessment §3) — just undici with
 * connection pooling.
 *
 * Keep-alive is the point of the pool: over a residential proxy each new
 * connection pays a TCP round trip plus a TLS handshake before a single useful
 * byte moves, which roughly triples the cost of a request. One dispatcher per
 * proxy session means a five-page walk pays that once instead of five times.
 */

export interface HttpRequest {
    readonly url: string;
    readonly method?: 'GET' | 'POST';
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    /** Proxy to route through. Also the pool key: one connection pool per session. */
    readonly proxyUrl?: string | undefined;
    readonly timeoutMs?: number;
}

export interface HttpResponse {
    readonly status: number;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly body: string;
}

export interface HttpClient {
    /** Resolves for every HTTP status; throws only when the request never completed. */
    request(request: HttpRequest): Promise<HttpResponse>;
    close(): Promise<void>;
}

/** A request that never reached a response: DNS, TCP, TLS or timeout. */
export class NetworkError extends Error {
    readonly code: string;

    constructor(message: string, code: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'NetworkError';
        this.code = code;
    }
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Mirrors what an anonymous Chrome sends, so our traffic is not gratuitously odd. */
const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface UndiciHttpClientOptions {
    /** Concurrent sockets per pool. HTTP/1.1 carries one request per connection. */
    readonly connections?: number;
    readonly keepAliveTimeoutMs?: number;
    readonly userAgent?: string;
}

export class UndiciHttpClient implements HttpClient {
    /** One dispatcher per proxy url, so sessions keep their own warm connections. */
    readonly #dispatchers = new Map<string, Dispatcher>();
    readonly #options: Required<UndiciHttpClientOptions>;

    constructor(options: UndiciHttpClientOptions = {}) {
        this.#options = {
            connections: options.connections ?? 4,
            keepAliveTimeoutMs: options.keepAliveTimeoutMs ?? 30_000,
            userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
        };
    }

    async request(request: HttpRequest): Promise<HttpResponse> {
        const dispatcher = this.#dispatcherFor(request.proxyUrl);

        try {
            const response = await undiciRequest(request.url, {
                method: request.method ?? 'GET',
                headers: { 'user-agent': this.#options.userAgent, ...request.headers },
                ...(request.body === undefined ? {} : { body: request.body }),
                dispatcher,
                headersTimeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                bodyTimeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            });

            return {
                status: response.statusCode,
                headers: flattenHeaders(response.headers),
                body: await response.body.text(),
            };
        } catch (error: unknown) {
            throw new NetworkError(describe(error), codeOf(error), { cause: error });
        }
    }

    #dispatcherFor(proxyUrl: string | undefined): Dispatcher {
        const key = proxyUrl ?? 'direct';
        const existing = this.#dispatchers.get(key);
        if (existing !== undefined) return existing;

        const created: Dispatcher =
            proxyUrl === undefined
                ? new Agent({
                      connections: this.#options.connections,
                      keepAliveTimeout: this.#options.keepAliveTimeoutMs,
                      pipelining: 1,
                  })
                : new ProxyAgent({
                      uri: proxyUrl,
                      connections: this.#options.connections,
                      keepAliveTimeout: this.#options.keepAliveTimeoutMs,
                      pipelining: 1,
                  });

        this.#dispatchers.set(key, created);
        return created;
    }

    async close(): Promise<void> {
        const dispatchers = [...this.#dispatchers.values()];
        this.#dispatchers.clear();
        await Promise.all(dispatchers.map((d) => d.close().catch(() => undefined)));
    }
}

function flattenHeaders(
    headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | undefined> {
    const flat: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(headers)) {
        flat[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
    return flat;
}

function codeOf(error: unknown): string {
    if (error != null && typeof error === 'object' && 'code' in error) {
        const { code } = error as { code: unknown };
        if (typeof code === 'string') return code;
    }
    return 'UNKNOWN';
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
