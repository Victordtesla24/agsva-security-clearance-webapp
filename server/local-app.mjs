#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const artifactsDir = path.join(rootDir, "artifacts", "server");
const aiArtifactsDir = path.join(artifactsDir, "ai-validations");
const requestLogPath = path.join(artifactsDir, "local-app-requests.jsonl");
const clientLogPath = path.join(artifactsDir, "browser-diagnostics.jsonl");
const blockedTopLevelEntries = new Set([
    "artifacts",
    "docs",
    "node_modules",
    "scripts",
    "server"
]);
const defaultDocumentCandidates = ["draft.html", "index.html"];
const envFilePath = process.env.LOCAL_APP_DISABLE_DOTENV === "1"
    ? ""
    : (process.env.LOCAL_APP_ENV_FILE || path.join(rootDir, ".env"));
const startedAt = new Date().toISOString();

if (envFilePath) loadEnvFile(envFilePath);
await fsp.mkdir(artifactsDir, { recursive: true });
await fsp.mkdir(aiArtifactsDir, { recursive: true });

const config = {
    host: getArgValue("--host") || process.env.LOCAL_APP_HOST || "127.0.0.1",
    port: Number.parseInt(getArgValue("--port") || process.env.LOCAL_APP_PORT || "3000", 10),
    defaultFile: resolveDefaultFile(process.env.LOCAL_APP_DEFAULT_FILE || "draft.html"),
    model: process.env.OPENAI_MODEL || "gpt-5.4",
    rateWindowSeconds: normalizeInteger(process.env.OPENAI_RATE_LIMIT_WINDOW_SECONDS, 300),
    maxRequestsPerWindow: normalizeInteger(process.env.OPENAI_MAX_REQUESTS_PER_WINDOW, 8),
    maxConcurrentRequests: normalizeInteger(process.env.OPENAI_MAX_CONCURRENT_REQUESTS, 1),
    requestTimeoutMs: normalizeInteger(process.env.OPENAI_REQUEST_TIMEOUT_MS, 25000),
    upstreamRetryAttempts: normalizeInteger(process.env.OPENAI_UPSTREAM_RETRY_ATTEMPTS, 2),
    maxPayloadBytes: normalizeInteger(process.env.LOCAL_APP_MAX_PAYLOAD_BYTES, 64 * 1024),
    apiKey: process.env.OPENAI_API_KEY || ""
};

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid port: ${config.port}`);
}

const rateLimitState = new Map();
let activeAiRequests = 0;
let lastUpstreamRateLimit = {
    requests: null,
    tokens: null,
    lastStatus: null,
    lastRequestId: "",
    recordedAt: "",
    retryAfterSeconds: null
};

const mimeTypes = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".ico", "image/x-icon"],
    [".jpeg", "image/jpeg"],
    [".jpg", "image/jpeg"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".png", "image/png"],
    [".svg", "image/svg+xml"],
    [".txt", "text/plain; charset=utf-8"],
    [".webm", "video/webm"],
    [".mp4", "video/mp4"]
]);

function getArgValue(name) {
    const exactIndex = process.argv.indexOf(name);
    if (exactIndex >= 0) return process.argv[exactIndex + 1] || "";
    const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
    return inline ? inline.slice(name.length + 1) : "";
}

function normalizeInteger(rawValue, fallback) {
    const parsed = Number.parseInt(rawValue ?? "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeDefaultFile(rawValue) {
    const candidate = String(rawValue || "").trim();
    if (!candidate) return "draft.html";

    const safePath = sanitizePathname(`/${candidate}`);
    if (!safePath) {
        throw new Error(`Invalid LOCAL_APP_DEFAULT_FILE: ${rawValue}`);
    }

    const normalized = safePath.replace(/^\/+/u, "");
    if (!normalized || normalized === ".") {
        throw new Error(`Invalid LOCAL_APP_DEFAULT_FILE: ${rawValue}`);
    }

    return normalized;
}

function isPathInsideRoot(filePath) {
    const relativePath = path.relative(rootDir, filePath);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPublicRelativePath(relativePath) {
    if (!relativePath) return false;

    const segments = relativePath.split("/").filter(Boolean);
    if (!segments.length) return false;

    if (segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."))) {
        return false;
    }

    if (blockedTopLevelEntries.has(segments[0])) {
        return false;
    }

    return true;
}

function resolveDefaultFile(rawValue) {
    const requested = normalizeDefaultFile(rawValue);
    const candidates = new Set([requested, ...defaultDocumentCandidates]);

    for (const candidate of candidates) {
        if (!isPublicRelativePath(candidate)) continue;

        const candidatePath = path.join(rootDir, candidate);
        if (!isPathInsideRoot(candidatePath)) continue;

        try {
            const stat = fs.statSync(candidatePath);
            if (stat.isFile()) {
                return candidate;
            }
        } catch {
            // Continue to the next candidate.
        }
    }

    throw new Error(`No readable default HTML document found for requested entry: ${rawValue}`);
}

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    const contents = fs.readFileSync(filePath, "utf8");

    for (const line of contents.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const separator = trimmed.indexOf("=");
        if (separator <= 0) continue;

        const key = trimmed.slice(0, separator).trim();
        let value = trimmed.slice(separator + 1).trim();

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}

function log(level, message, metadata = null) {
    const prefix = `${new Date().toISOString()} [${level}] ${message}`;
    if (!metadata) {
        console.log(prefix);
        return;
    }
    console.log(`${prefix} ${JSON.stringify(metadata)}`);
}

async function appendJsonLine(filePath, payload) {
    await fsp.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function countJsonLines(filePath) {
    if (!fs.existsSync(filePath)) return 0;
    const contents = fs.readFileSync(filePath, "utf8").trim();
    if (!contents) return 0;
    return contents.split(/\r?\n/u).length;
}

function trackRequest(request, response, pathname) {
    const started = process.hrtime.bigint();
    response.on("finish", () => {
        const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
        void appendJsonLine(requestLogPath, {
            recordedAt: new Date().toISOString(),
            method: request.method || "GET",
            pathname,
            statusCode: response.statusCode,
            durationMs: Number(durationMs.toFixed(2)),
            clientKey: getClientKey(request)
        }).catch((error) => {
            log("ERROR", "Failed to persist request log entry", {
                message: error.message,
                pathname
            });
        });
    });
}

function json(response, statusCode, payload, extraHeaders = {}) {
    response.writeHead(statusCode, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...extraHeaders
    });
    response.end(JSON.stringify(payload, null, 2));
}

function text(response, statusCode, body, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
    response.writeHead(statusCode, {
        "content-type": contentType,
        "cache-control": "no-store",
        ...extraHeaders
    });
    response.end(body);
}

function sanitizePathname(rawPathname) {
    let decoded = "";
    try {
        decoded = decodeURIComponent(rawPathname);
    } catch {
        return null;
    }
    const normalized = path.posix.normalize(decoded.replace(/\\/gu, "/"));
    if (normalized.includes("..")) return null;
    return normalized;
}

function resolveStaticPath(pathname) {
    if (pathname === "/" || pathname === "") {
        return {
            status: "ok",
            filePath: path.join(rootDir, config.defaultFile)
        };
    }

    const safePath = sanitizePathname(pathname);
    if (!safePath) return {
        status: "invalid"
    };

    const relativePath = safePath.replace(/^\/+/u, "");
    if (!relativePath) {
        return {
            status: "ok",
            filePath: path.join(rootDir, config.defaultFile)
        };
    }

    if (!isPublicRelativePath(relativePath)) {
        return {
            status: "blocked"
        };
    }

    const absolutePath = path.join(rootDir, relativePath);
    if (!isPathInsideRoot(absolutePath)) {
        return {
            status: "invalid"
        };
    }

    return {
        status: "ok",
        filePath: absolutePath
    };
}

function deriveMimeType(filePath) {
    return mimeTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function isPrimaryDocumentPath(pathname) {
    return pathname === "/" || pathname === "" || pathname === `/${config.defaultFile}`;
}

async function serveStatic(request, response, pathname) {
    const resolution = resolveStaticPath(pathname);
    if (resolution.status === "invalid") {
        text(response, 400, "Invalid path");
        return;
    }

    if (resolution.status === "blocked") {
        text(response, 404, "Not found");
        return;
    }

    const filePath = resolution.filePath;

    try {
        const stat = await fsp.stat(filePath);
        if (stat.isDirectory()) {
            text(response, 404, "Not found");
            return;
        }

        response.writeHead(200, {
            "content-type": deriveMimeType(filePath),
            "content-length": stat.size,
            "cache-control": isPrimaryDocumentPath(pathname) ? "no-store" : "public, max-age=300"
        });

        if (request.method === "HEAD") {
            response.end();
            return;
        }

        fs.createReadStream(filePath).pipe(response);
    } catch (error) {
        text(response, 404, "Not found");
    }
}

async function readJsonBody(request) {
    let size = 0;
    const chunks = [];

    for await (const chunk of request) {
        size += chunk.length;
        if (size > config.maxPayloadBytes) {
            throw new HttpError(413, `Payload exceeds ${config.maxPayloadBytes} bytes.`);
        }
        chunks.push(chunk);
    }

    if (!chunks.length) return {};
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new HttpError(400, "Request body must be valid JSON.");
    }
}

function getClientKey(request) {
    return request.headers["x-forwarded-for"]?.toString().split(",")[0].trim()
        || request.socket.remoteAddress
        || "local";
}

function pruneRateWindow(entry, now) {
    const windowMs = config.rateWindowSeconds * 1000;
    entry.timestamps = entry.timestamps.filter((timestamp) => now - timestamp < windowMs);
    return entry;
}

function checkLocalRateLimit(clientKey) {
    const now = Date.now();
    const entry = pruneRateWindow(rateLimitState.get(clientKey) || { timestamps: [] }, now);
    const remaining = Math.max(0, config.maxRequestsPerWindow - entry.timestamps.length);

    if (entry.timestamps.length >= config.maxRequestsPerWindow) {
        const oldest = entry.timestamps[0];
        const retryAfterSeconds = Math.max(1, Math.ceil(((oldest + (config.rateWindowSeconds * 1000)) - now) / 1000));
        rateLimitState.set(clientKey, entry);
        return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds
        };
    }

    entry.timestamps.push(now);
    rateLimitState.set(clientKey, entry);
    return {
        allowed: true,
        remaining: Math.max(0, config.maxRequestsPerWindow - entry.timestamps.length),
        retryAfterSeconds: 0
    };
}

function healthPayload() {
    const aiArtifacts = fs.existsSync(aiArtifactsDir)
        ? fs.readdirSync(aiArtifactsDir).filter((name) => name.endsWith(".json")).length
        : 0;
    const requestLogCount = countJsonLines(requestLogPath);
    const clientDiagnosticCount = countJsonLines(clientLogPath);

    return {
        ok: true,
        server: {
            startedAt,
            envFilePresent: Boolean(envFilePath) && fs.existsSync(envFilePath),
            rootDir,
            artifactsDir,
            defaultFile: config.defaultFile,
            logs: {
                requestLogPath,
                clientLogPath
            }
        },
        ai: {
            configured: Boolean(config.apiKey),
            model: config.model,
            localLimiter: {
                windowSeconds: config.rateWindowSeconds,
                maxRequestsPerWindow: config.maxRequestsPerWindow,
                maxConcurrentRequests: config.maxConcurrentRequests,
                activeRequests: activeAiRequests
            },
            upstream: lastUpstreamRateLimit,
            endpoints: {
                validate: "/api/ai/validate"
            }
        },
        artifacts: {
            aiValidationCount: aiArtifacts,
            requestLogCount,
            clientDiagnosticCount
        }
    };
}

function extractRateLimitHeaders(headers) {
    const requestsLimit = headers.get("x-ratelimit-limit-requests");
    const requestsRemaining = headers.get("x-ratelimit-remaining-requests");
    const requestsReset = headers.get("x-ratelimit-reset-requests");
    const tokensLimit = headers.get("x-ratelimit-limit-tokens");
    const tokensRemaining = headers.get("x-ratelimit-remaining-tokens");
    const tokensReset = headers.get("x-ratelimit-reset-tokens");
    const retryAfter = headers.get("retry-after");

    return {
        requests: requestsLimit || requestsRemaining || requestsReset ? {
            limit: requestsLimit,
            remaining: requestsRemaining,
            reset: requestsReset
        } : null,
        tokens: tokensLimit || tokensRemaining || tokensReset ? {
            limit: tokensLimit,
            remaining: tokensRemaining,
            reset: tokensReset
        } : null,
        retryAfterSeconds: retryAfter ? Number.parseInt(retryAfter, 10) || null : null
    };
}

function parseResetSeconds(resetValue) {
    if (!resetValue) return null;
    const match = /(\d+)(ms|s|m|h)/u.exec(resetValue);
    if (!match) return null;
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2];
    if (unit === "ms") return Math.max(1, Math.ceil(amount / 1000));
    if (unit === "s") return amount;
    if (unit === "m") return amount * 60;
    if (unit === "h") return amount * 3600;
    return null;
}

function updateUpstreamRateLimit(headers, status, requestId) {
    const extracted = extractRateLimitHeaders(headers);
    lastUpstreamRateLimit = {
        ...extracted,
        lastStatus: status,
        lastRequestId: requestId,
        recordedAt: new Date().toISOString(),
        retryAfterSeconds: extracted.retryAfterSeconds
            || parseResetSeconds(extracted.requests?.reset)
            || parseResetSeconds(extracted.tokens?.reset)
            || null
    };
}

function buildValidationPrompt(kind, payload) {
    const instruction = kind === "disclosure"
        ? "Review the disclosure draft for factual completeness, clarity, context, and evidence posture."
        : "Review the workspace readiness summary for missing controls, chronology risks, and action gaps.";

    return [
        "You are a strict AGSVA readiness validation assistant.",
        instruction,
        "Return only valid JSON with this exact schema:",
        JSON.stringify({
            verdict: "ready | review | block",
            summary: "string",
            findings: [
                {
                    severity: "critical | warning | info",
                    section: "string",
                    field: "string",
                    title: "string",
                    detail: "string",
                    action: "string"
                }
            ],
            next_steps: ["string"]
        }, null, 2),
        "Do not include markdown fences or prose outside the JSON object.",
        "Payload:",
        JSON.stringify(payload, null, 2)
    ].join("\n\n");
}

function extractResponseText(data) {
    if (typeof data.output_text === "string" && data.output_text.trim()) {
        return data.output_text.trim();
    }

    if (Array.isArray(data.output)) {
        const pieces = [];
        for (const item of data.output) {
            if (!Array.isArray(item.content)) continue;
            for (const content of item.content) {
                if (typeof content.text === "string") pieces.push(content.text);
                if (typeof content.output_text === "string") pieces.push(content.output_text);
            }
        }
        if (pieces.length) return pieces.join("\n").trim();
    }

    return "";
}

function parseJsonFromModel(textValue) {
    try {
        return JSON.parse(textValue);
    } catch (error) {
        const fenced = textValue.match(/```(?:json)?\s*([\s\S]+?)```/u);
        if (fenced) return JSON.parse(fenced[1]);

        const firstBrace = textValue.indexOf("{");
        const lastBrace = textValue.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            return JSON.parse(textValue.slice(firstBrace, lastBrace + 1));
        }
        throw error;
    }
}

function sanitizeValidationRequest(body) {
    const kind = body?.kind;
    if (!["disclosure", "workspace"].includes(kind)) {
        throw new HttpError(400, "Validation kind must be 'disclosure' or 'workspace'.");
    }

    if (!body?.payload || typeof body.payload !== "object") {
        throw new HttpError(400, "Validation payload is required.");
    }

    return {
        kind,
        payload: body.payload
    };
}

function sanitizeClientDiagnostic(body) {
    const level = ["info", "warn", "error"].includes(body?.level) ? body.level : "info";
    const source = typeof body?.source === "string" && body.source.trim()
        ? body.source.trim().slice(0, 80)
        : "client";
    const message = typeof body?.message === "string" && body.message.trim()
        ? body.message.trim().slice(0, 280)
        : "";

    if (!message) {
        throw new HttpError(400, "Client diagnostic message is required.");
    }

    let detail = "";
    if (typeof body?.detail === "string") {
        detail = body.detail.slice(0, 2000);
    } else if (body?.detail != null) {
        detail = JSON.stringify(body.detail).slice(0, 2000);
    }

    return {
        level,
        source,
        message,
        detail,
        recordedAt: new Date().toISOString()
    };
}

function sanitizeArtifactToken(value) {
    const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/gu, "-");
    return normalized || crypto.randomUUID();
}

async function persistAiArtifact(artifact) {
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const fileName = `${timestamp}-${artifact.kind}-${sanitizeArtifactToken(artifact.requestId)}.json`;
    const filePath = path.join(aiArtifactsDir, fileName);
    await fsp.writeFile(filePath, JSON.stringify(artifact, null, 2));
    return fileName;
}

async function callOpenAiValidation(kind, payload) {
    if (!config.apiKey) {
        throw new HttpError(503, "OpenAI API key is not configured in .env.");
    }

    const requestBody = {
        model: config.model,
        input: buildValidationPrompt(kind, payload)
    };

    let attempt = 0;
    let lastError = null;

    while (attempt <= config.upstreamRetryAttempts) {
        attempt += 1;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

        try {
            const response = await fetch("https://api.openai.com/v1/responses", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });
            clearTimeout(timeout);

            const requestId = response.headers.get("x-request-id") || "";
            updateUpstreamRateLimit(response.headers, response.status, requestId);

            const data = await response.json().catch(() => ({}));
            const responseText = extractResponseText(data);

            if (!response.ok) {
                const retryAfterSeconds = lastUpstreamRateLimit.retryAfterSeconds
                    || extractRateLimitHeaders(response.headers).retryAfterSeconds
                    || 0;

                if ((response.status === 429 || response.status >= 500) && attempt <= config.upstreamRetryAttempts) {
                    const backoffSeconds = retryAfterSeconds || Math.min(8, 2 ** (attempt - 1));
                    await delay((backoffSeconds * 1000) + Math.floor(Math.random() * 250));
                    continue;
                }

                throw new HttpError(response.status, data?.error?.message || "OpenAI validation request failed.", {
                    requestId,
                    rateLimit: lastUpstreamRateLimit,
                    responseBody: data
                });
            }

            const parsed = parseJsonFromModel(responseText);
            const artifact = {
                kind,
                requestId,
                model: config.model,
                generatedAt: new Date().toISOString(),
                rateLimit: lastUpstreamRateLimit,
                inputDigest: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
                result: parsed,
                rawText: responseText
            };
            const artifactFile = await persistAiArtifact(artifact);

            return {
                requestId,
                artifactFile,
                model: config.model,
                rateLimit: lastUpstreamRateLimit,
                result: parsed
            };
        } catch (error) {
            clearTimeout(timeout);
            lastError = error;
            if (error.name === "AbortError" && attempt <= config.upstreamRetryAttempts) {
                await delay(Math.min(8, 2 ** (attempt - 1)) * 1000);
                continue;
            }
            if (error instanceof HttpError) throw error;
            throw new HttpError(502, error.message || "OpenAI request failed unexpectedly.");
        }
    }

    throw lastError instanceof Error ? lastError : new HttpError(502, "OpenAI request failed unexpectedly.");
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class HttpError extends Error {
    constructor(statusCode, message, metadata = null) {
        super(message);
        this.statusCode = statusCode;
        this.metadata = metadata;
    }
}

async function handleAiValidation(request, response) {
    const clientKey = getClientKey(request);
    const limit = checkLocalRateLimit(clientKey);

    if (!limit.allowed) {
        json(response, 429, {
            ok: false,
            error: "Local AI validation rate limit exceeded.",
            retryAfterSeconds: limit.retryAfterSeconds,
            rateLimit: {
                scope: "local",
                remaining: limit.remaining,
                windowSeconds: config.rateWindowSeconds,
                maxRequestsPerWindow: config.maxRequestsPerWindow
            }
        }, {
            "retry-after": String(limit.retryAfterSeconds)
        });
        return;
    }

    if (activeAiRequests >= config.maxConcurrentRequests) {
        json(response, 429, {
            ok: false,
            error: "AI validation is already running. Wait for the current request to finish.",
            retryAfterSeconds: 2,
            rateLimit: {
                scope: "local-concurrency",
                activeRequests: activeAiRequests,
                maxConcurrentRequests: config.maxConcurrentRequests
            }
        }, {
            "retry-after": "2"
        });
        return;
    }

    activeAiRequests += 1;

    try {
        const body = sanitizeValidationRequest(await readJsonBody(request));
        const outcome = await callOpenAiValidation(body.kind, body.payload);
        json(response, 200, {
            ok: true,
            kind: body.kind,
            requestId: outcome.requestId,
            artifactFile: outcome.artifactFile,
            model: outcome.model,
            rateLimit: outcome.rateLimit,
            result: outcome.result
        });
    } catch (error) {
        const httpError = error instanceof HttpError ? error : new HttpError(500, "Unexpected validation failure.");
        log("ERROR", "AI validation failed", {
            statusCode: httpError.statusCode,
            message: httpError.message,
            metadata: httpError.metadata
        });
        json(response, httpError.statusCode, {
            ok: false,
            error: httpError.message,
            metadata: httpError.metadata || null
        }, httpError.metadata?.rateLimit?.retryAfterSeconds ? {
            "retry-after": String(httpError.metadata.rateLimit.retryAfterSeconds)
        } : {});
    } finally {
        activeAiRequests = Math.max(0, activeAiRequests - 1);
    }
}

async function handleClientDiagnostic(request, response) {
    const body = sanitizeClientDiagnostic(await readJsonBody(request));
    await appendJsonLine(clientLogPath, body);
    json(response, 202, {
        ok: true
    });
}

const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || `${config.host}:${config.port}`}`);
    const pathname = requestUrl.pathname;
    trackRequest(request, response, pathname);

    try {
        if (pathname === "/api/health" && request.method === "GET") {
            json(response, 200, healthPayload());
            return;
        }

        if (pathname === "/api/logs/client" && request.method === "POST") {
            await handleClientDiagnostic(request, response);
            return;
        }

        if (pathname === "/api/ai/validate" && request.method === "POST") {
            await handleAiValidation(request, response);
            return;
        }

        if (["GET", "HEAD"].includes(request.method || "")) {
            await serveStatic(request, response, pathname);
            return;
        }

        text(response, 405, "Method not allowed");
    } catch (error) {
        log("ERROR", "Unhandled request failure", {
            pathname,
            method: request.method,
            message: error instanceof Error ? error.message : String(error)
        });
        json(response, 500, {
            ok: false,
            error: "Local server request failed unexpectedly."
        });
    }
});

server.listen(config.port, config.host, () => {
    log("INFO", "Local AGSVA server ready", {
        host: config.host,
        port: config.port,
        defaultFile: config.defaultFile,
        model: config.model,
        openAiConfigured: Boolean(config.apiKey)
    });
});
