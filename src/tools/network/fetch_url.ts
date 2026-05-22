import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { promises as dns } from "node:dns";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result, type StructuredError } from "../../core/errors.js";
import { resolveTimeoutMs } from "../../core/timeouts.js";

const MAX_REDIRECTS = 3;
const ALLOWED_HEADERS = new Set([
  "user-agent",
  "accept",
  "accept-language",
]);

const InputShape = {
  url: z
    .string()
    .min(1)
    .max(8 * 1024)
    .describe("Absolute http:// or https:// URL."),
  headers: z
    .record(z.string().max(2048))
    .optional()
    .describe("Optional headers. Only User-Agent / Accept / Accept-Language allowed."),
  max_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap on response body. Default config.fetchUrlMaxBytes."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Wall-clock cap. Default config.fetchUrlTimeoutMs."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  status_code: z.number().int(),
  content_type: z.string(),
  body: z.string(),
  bytes_received: z.number().int().nonnegative(),
  truncated: z.boolean(),
  final_url: z.string(),
  redirect_hops: z.number().int().nonnegative(),
} as const;

interface FetchUrlResult extends Record<string, unknown> {
  status_code: number;
  content_type: string;
  body: string;
  bytes_received: number;
  truncated: boolean;
  final_url: string;
  redirect_hops: number;
}

interface FetchAuditExtras {
  url_redacted: string;
  status_code: number;
  bytes_received: number;
  redirect_hops: number;
  headers_allowed: string[];
}

const auditByResult = new WeakMap<object, FetchAuditExtras>();

export function getFetchUrlAuditExtras(value: FetchUrlResult): FetchAuditExtras | undefined {
  return auditByResult.get(value);
}

export function redactUrlForAudit(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.search) u.search = "?<redacted>";
    if (u.username) u.username = "<redacted>";
    if (u.password) u.password = "<redacted>";
    return u.toString();
  } catch {
    return "<malformed>";
  }
}

export function isInternalIP(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((p) => parseInt(p, 10));
    const [a, b, c, d] = parts as [number, number, number, number];
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 0 && b === 0 && c === 0 && d === 0) return true; // 0.0.0.0
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
    if (lower.startsWith("fe80")) return true; // fe80::/10 link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
    // IPv4-mapped IPv6 (::ffff:a.b.c.d)
    const m = lower.match(/^::ffff:([0-9a-f.:]+)$/);
    if (m) {
      const inner = m[1]!;
      if (net.isIPv4(inner)) return isInternalIP(inner);
    }
    return false;
  }
  return true; // unknown form — refuse
}

function validateProtocol(url: URL): StructuredError | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return buildError("EHOSTNOTALLOWED", "only http:// and https:// are allowed", {
      details: { url: redactUrlForAudit(url.toString()), protocol: url.protocol },
    });
  }
  return undefined;
}

/**
 * True when a redirect hop would step DOWN from https: to http: — the
 * canonical SSRF-downgrade attack against whitelisted hosts whose owners
 * configure a misbehaving HTTPS→HTTP rewrite. Used in the redirect loop
 * to reject such hops with EHOSTNOTALLOWED + details.reason="protocol_downgrade".
 *
 * The reverse direction (http → https) is NOT classified as a downgrade —
 * upgrading the channel mid-redirect is benign.
 */
export function isProtocolDowngrade(from: URL, to: URL): boolean {
  return from.protocol === "https:" && to.protocol === "http:";
}

function validateHostWhitelist(url: URL, config: ResolvedConfig): StructuredError | undefined {
  const host = url.hostname.toLowerCase();
  // P2.8: trim AND lowercase. Operator misconfiguration (trailing/leading
  // whitespace in config) would otherwise silently reject every request to
  // the affected host. 3/3 reviewer convergence (Codex, Kimi, DeepSeek).
  const allowed = config.allowedUrlHosts.map((h) => h.trim().toLowerCase());
  if (!allowed.includes(host)) {
    return buildError("EHOSTNOTALLOWED", "host is not in allowedUrlHosts", {
      details: { host, allowed_count: allowed.length },
      hint: "Add the hostname to config.allowedUrlHosts (exact match, case-insensitive).",
    });
  }
  return undefined;
}

async function resolveAndDenyInternal(
  url: URL,
): Promise<{ ip: string; family: 4 | 6 } | StructuredError> {
  const host = url.hostname;
  // If the hostname IS an IP literal already, validate directly.
  if (net.isIP(host)) {
    if (isInternalIP(host)) {
      return buildError("EHOSTNOTALLOWED", "host resolves to an internal IP", {
        details: { host, resolved_ip: host },
      });
    }
    return { ip: host, family: net.isIPv4(host) ? 4 : 6 };
  }
  let resolved;
  try {
    resolved = await dns.lookup(host, { all: false });
  } catch (err) {
    return buildError("EHOSTNOTALLOWED", "DNS lookup failed", {
      details: { host, cause: (err as Error).message },
    });
  }
  if (isInternalIP(resolved.address)) {
    return buildError("EHOSTNOTALLOWED", "host resolves to an internal IP", {
      details: { host, resolved_ip: resolved.address },
    });
  }
  return { ip: resolved.address, family: resolved.family === 6 ? 6 : 4 };
}

function buildRequestHeaders(
  url: URL,
  userHeaders: Record<string, string> | undefined,
): { headers: Record<string, string>; allowed: string[] } | StructuredError {
  const headers: Record<string, string> = {
    Host: url.host, // explicit Host header — needed when we connect-by-IP
    "User-Agent": "mcp-winfs/0.5 (https://github.com/leonovee/winfs-mcp)",
    Accept: "*/*",
    "Accept-Encoding": "identity", // disable compression so byte counts are honest
    Connection: "close",
  };
  const allowedList: string[] = [];
  if (userHeaders) {
    for (const [k, v] of Object.entries(userHeaders)) {
      const lower = k.toLowerCase();
      if (!ALLOWED_HEADERS.has(lower)) {
        return buildError("EINVAL", `header not allowed: ${k}`, {
          details: { name: k, allowed: [...ALLOWED_HEADERS] },
          hint: "Only User-Agent / Accept / Accept-Language may be passed.",
        });
      }
      // Title-case the canonical name (User-Agent, Accept, Accept-Language).
      const canonical = lower
        .split("-")
        .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
        .join("-");
      headers[canonical] = v;
      allowedList.push(canonical);
    }
  }
  return { headers, allowed: allowedList };
}

interface FetchOnceArgs {
  url: URL;
  config: ResolvedConfig;
  maxBytes: number;
  deadlineRemainingMs: number;
  userHeaders: Record<string, string> | undefined;
  signal?: AbortSignal;
}

interface FetchOnceResult {
  statusCode: number;
  contentType: string;
  body: string;
  bytesReceived: number;
  truncated: boolean;
  /** Location header for 3xx responses; undefined otherwise. */
  redirectTo?: string;
  /** Headers list that survived the allowlist (for audit). */
  headersAllowed: string[];
}

async function fetchOnce(p: FetchOnceArgs): Promise<FetchOnceResult | StructuredError> {
  const protoCheck = validateProtocol(p.url);
  if (protoCheck) return protoCheck;
  const wlCheck = validateHostWhitelist(p.url, p.config);
  if (wlCheck) return wlCheck;
  const resolved = await resolveAndDenyInternal(p.url);
  if ("ok" in resolved && resolved.ok === false) return resolved as StructuredError;
  const { ip } = resolved as { ip: string; family: 4 | 6 };

  const hdrBuild = buildRequestHeaders(p.url, p.userHeaders);
  if ("ok" in hdrBuild && hdrBuild.ok === false) return hdrBuild as StructuredError;
  const { headers, allowed } = hdrBuild as { headers: Record<string, string>; allowed: string[] };

  // Use the resolved IP as the connect target. Pass servername=hostname for
  // TLS SNI + cert validation on https.
  const isHttps = p.url.protocol === "https:";
  const port =
    p.url.port !== ""
      ? parseInt(p.url.port, 10)
      : isHttps
        ? 443
        : 80;
  const path = `${p.url.pathname}${p.url.search}`;

  return new Promise<FetchOnceResult | StructuredError>((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let received = 0;
    let truncated = false;
    let statusCode = 0;
    let contentType = "";
    let redirectTo: string | undefined;
    let req: http.ClientRequest;

    const safeResolve = (v: FetchOnceResult | StructuredError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };

    const deadlineTimer = setTimeout(() => {
      safeResolve(
        buildError("ETIMEDOUT", "fetch_url exceeded deadline", {
          details: {
            url: redactUrlForAudit(p.url.toString()),
            timeout_ms: p.deadlineRemainingMs,
          },
        }),
      );
    }, p.deadlineRemainingMs);
    deadlineTimer.unref?.();

    if (p.signal) {
      if (p.signal.aborted) {
        safeResolve(buildError("ETIMEDOUT", "fetch_url aborted", {}));
        return;
      }
      p.signal.addEventListener(
        "abort",
        () => {
          safeResolve(buildError("ETIMEDOUT", "fetch_url aborted", {}));
        },
        { once: true },
      );
    }

    const reqOpts: http.RequestOptions = {
      method: "GET",
      host: ip,
      port,
      path,
      headers,
      // Don't auto-follow redirects — we re-validate each hop ourselves.
    };

    const lib = isHttps ? https : http;
    const httpsOpts = isHttps
      ? {
          ...reqOpts,
          servername: p.url.hostname, // SNI uses real hostname
          // P1.2: pin cert validation as defense-in-depth. Node's default is
          // `true`, so this is a no-op today — the point is to make the value
          // explicit so a future runtime override (test setup, dependency
          // side-effect, https.globalAgent reassignment) can't silently
          // disable certificate validation for this codepath.
          rejectUnauthorized: true,
        }
      : reqOpts;

    try {
      req = lib.request(httpsOpts, (res) => {
        statusCode = res.statusCode ?? 0;
        contentType = (res.headers["content-type"] as string | undefined) ?? "";
        const cl = parseInt((res.headers["content-length"] as string | undefined) ?? "0", 10);
        if (cl > 0 && cl > p.maxBytes) {
          safeResolve(
            buildError("ESIZE", "Content-Length exceeds max_bytes", {
              details: { content_length: cl, max_bytes: p.maxBytes },
            }),
          );
          return;
        }
        if (statusCode >= 300 && statusCode < 400) {
          const loc = res.headers["location"];
          if (typeof loc === "string") {
            redirectTo = loc;
          }
        }
        res.on("data", (chunk: Buffer) => {
          if (received + chunk.length <= p.maxBytes) {
            chunks.push(chunk);
            received += chunk.length;
          } else {
            const remaining = p.maxBytes - received;
            if (remaining > 0) {
              chunks.push(chunk.subarray(0, remaining));
              received = p.maxBytes;
            }
            truncated = true;
            // If the stream is over the cap and there's no Content-Length to
            // pre-check, kill the connection — fail-closed.
            if (chunks.length === 0 || received >= p.maxBytes) {
              safeResolve(
                buildError("ESIZE", "streamed body exceeds max_bytes", {
                  details: { received, max_bytes: p.maxBytes },
                }),
              );
              return;
            }
          }
        });
        res.on("end", () => {
          safeResolve({
            statusCode,
            contentType,
            body: Buffer.concat(chunks).toString("utf8"),
            bytesReceived: received,
            truncated,
            ...(redirectTo ? { redirectTo } : {}),
            headersAllowed: allowed,
          });
        });
        res.on("error", (err) => {
          safeResolve(
            buildError("EIO", "fetch_url response error", {
              details: { cause: err.message },
            }),
          );
        });
      });
      req.on("error", (err) => {
        safeResolve(
          buildError("EIO", "fetch_url request error", {
            details: { cause: err.message },
          }),
        );
      });
      req.end();
    } catch (err) {
      safeResolve(
        buildError("EIO", "fetch_url failed to start request", {
          details: { cause: (err as Error).message },
        }),
      );
    }
  });
}

export async function fetchUrlImpl(
  args: Input,
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<Result<FetchUrlResult>> {
  let url: URL;
  try {
    url = new URL(args.url);
  } catch {
    return buildError("EINVAL", "url is not a valid absolute URL", {
      details: { url: args.url.slice(0, 256) },
    });
  }

  const hardCap = config.fetchUrlMaxBytes; // spec cap
  const maxBytes = Math.min(args.max_bytes ?? hardCap, hardCap);
  const totalDeadline = resolveTimeoutMs(
    args.timeout_ms,
    config.fetchUrlTimeoutMs,
    config.fetchUrlTimeoutMs, // wall-clock max == default; override can only LOWER
  );
  const overallStart = Date.now();

  let currentUrl = url;
  let hops = 0;
  let lastResult: FetchOnceResult | undefined;

  while (true) {
    if (hops > MAX_REDIRECTS) {
      return buildError("EHOSTNOTALLOWED", "redirect chain exceeded max hops", {
        details: { max_redirects: MAX_REDIRECTS, final_url: redactUrlForAudit(currentUrl.toString()) },
      });
    }
    const remaining = totalDeadline - (Date.now() - overallStart);
    if (remaining <= 0) {
      return buildError("ETIMEDOUT", "fetch_url exceeded total deadline", {
        details: { timeout_ms: totalDeadline },
      });
    }
    const res = await fetchOnce({
      url: currentUrl,
      config,
      maxBytes,
      deadlineRemainingMs: remaining,
      userHeaders: args.headers,
      signal,
    });
    if ("ok" in res && res.ok === false) return res as StructuredError;
    const hop = res as FetchOnceResult;
    lastResult = hop;
    if (hop.redirectTo === undefined) {
      // Final response.
      const value: FetchUrlResult = {
        status_code: hop.statusCode,
        content_type: hop.contentType,
        body: hop.body,
        bytes_received: hop.bytesReceived,
        truncated: hop.truncated,
        final_url: currentUrl.toString(),
        redirect_hops: hops,
      };
      auditByResult.set(value, {
        url_redacted: redactUrlForAudit(args.url),
        status_code: hop.statusCode,
        bytes_received: hop.bytesReceived,
        redirect_hops: hops,
        headers_allowed: hop.headersAllowed,
      });
      return ok(value);
    }
    // Resolve next URL (relative or absolute).
    let nextUrl: URL;
    try {
      nextUrl = new URL(hop.redirectTo, currentUrl);
    } catch {
      return buildError("EIO", "redirect target is not a valid URL", {
        details: { location: hop.redirectTo.slice(0, 256) },
      });
    }
    // Block HTTPS → HTTP downgrade on the redirect hop. validateProtocol on
    // the next iteration accepts both schemes, so without this check a
    // whitelisted server's `Location: http://...` would silently land the
    // request on plain HTTP. http → https remains allowed (channel upgrade).
    if (isProtocolDowngrade(currentUrl, nextUrl)) {
      return buildError("EHOSTNOTALLOWED", "redirect would downgrade https → http", {
        details: {
          from: currentUrl.protocol,
          to: nextUrl.protocol,
          from_host: currentUrl.hostname,
          to_host: nextUrl.hostname,
          reason: "protocol_downgrade",
        },
        hint: "Redirect target uses a less-secure protocol than the originating request; refusing the hop.",
      });
    }
    hops++;
    currentUrl = nextUrl;
  }
}

export function registerFetchUrlTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "fetch_url",
    {
      title: "HTTP/HTTPS GET with SSRF-hardened defenses",
      description: `GET an absolute http:// or https:// URL with two-layer host validation, a 5 MB
hard cap, a 15 s wall-clock cap (defaults), and TOCTOU-safe redirect handling.

Layered defenses:
  1. Protocol whitelist: only \`http:\` / \`https:\`. Anything else → EHOSTNOTALLOWED.
  2. Host whitelist: \`url.hostname\` must be exactly in \`config.allowedUrlHosts\`
     (case-insensitive). Not in list → EHOSTNOTALLOWED before DNS.
  3. DNS resolve: hostname → IP via \`dns.lookup\`. Resolved IP checked against
     internal ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
     169.254.0.0/16, ::1, fc00::/7, fe80::/10). Match → EHOSTNOTALLOWED.
  4. TOCTOU mitigation: connection target is the RESOLVED IP; HTTP \`Host\` header
     is set to the original hostname, and TLS SNI / cert validation use the
     original hostname. A DNS re-bind after our check cannot redirect the connect.

Body cap: \`max_bytes\` (≤ config.fetchUrlMaxBytes, default 5 MB). Content-Length
checked pre-body; streamed overrun kills the socket → ESIZE.

Redirects: up to 3 hops. Each hop is re-validated through ALL layers (protocol,
whitelist, DNS, internal-IP). Hop 2 to a blocked host → EHOSTNOTALLOWED.

Headers: only \`User-Agent\` / \`Accept\` / \`Accept-Language\` accepted. \`Authorization\`,
\`Cookie\`, custom \`X-*\` → EINVAL. \`Accept-Encoding: identity\` is forced so byte counts
are honest. No request body in v0.5 (GET only).

Args:
  - url (string): absolute URL
  - headers (Record<string, string>, optional)
  - max_bytes (number, optional)
  - timeout_ms (number, optional; can only LOWER the default)

Returns: { status_code, content_type, body, bytes_received, truncated, final_url, redirect_hops }

Errors: EINVAL (malformed URL, disallowed header), EHOSTNOTALLOWED (whitelist miss,
internal-IP after DNS, non-http/https, redirect-chain overflow), ESIZE (body cap),
ETIMEDOUT (wall-clock), EIO.

Audit log redacts URL query string + userinfo. Headers logged are only the names
that survived the allowlist.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(
        {
          tool: "fetch_url",
          config,
          auditExtras: (result) => {
            if (!result.ok) {
              return { url_redacted: redactUrlForAudit((args as Input).url) };
            }
            const extras = getFetchUrlAuditExtras(result.value as FetchUrlResult);
            return extras ? { ...extras } : {};
          },
        },
        args,
        (a, sig) => fetchUrlImpl(a as Input, config, sig),
      ),
  );
}
