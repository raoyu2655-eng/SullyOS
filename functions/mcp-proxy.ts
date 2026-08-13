/**
 * MCP 的 Pages Functions 代理 —— 把 `worker/mcp-proxy/` 搬到本站自己的域名下。
 *
 * 背景：浏览器直连远程 MCP 服务器经常被 CORS 拦住（读不到 `Mcp-Session-Id` 响应头，
 * 握手第一步就死）。仓库原有两条解法——本地 `scripts/mcp-proxy.mjs`，或者自部署
 * `worker/mcp-proxy/` 到 `*.workers.dev`。手机上第一条不存在（没有 localhost），
 * 第二条撞的是同一个老问题：`*.workers.dev` 在国内经常连不上，部署完照样用不了。
 *
 * 这一份跟 `functions/amsg/[[path]].ts` 是同一个思路：**代理就架在本站自己身上**。
 * 用户既然能打开 SullyOS，这个域名对他就是可达的，不用再赌第三个域名通不通，
 * 也不用多建一个 Worker。跟前端一起部署，推代码就生效。
 *
 * 用法：设置 → MCP 工具服务器 → 某个服务器的「代理 URL」填 `https://<你的站>/mcp-proxy`。
 *      `?target=` 由前端自己拼（见 utils/mcpClient.ts 的 buildMcpFetchUrl），不用手写。
 *
 * ⚠️ **不设 PROXY_KEY 的话，这就是一个公开的转发端点**——别人扫到就能借你的域名转发
 * 流量。想关掉这个口子：在 Pages 项目的 Settings → Environment variables 里加一条
 * `MCP_PROXY_KEY`，再把同样的值填进设置页的「代理密钥」。行为与 worker 版一致。
 *
 * 转发的是什么：只有用户明确配置的那些头（Bearer / 自定义头 / MCP 协议头）。
 * 用户的 Token 从浏览器直达目标服务器，中间这一层不存任何东西、不认任何业务端点。
 */

interface Env {
  /** 可选的防白嫖密钥。设了就要求请求带同值的 X-Proxy-Key。 */
  MCP_PROXY_KEY?: string;
}

/**
 * Pages Functions 的运行时类型只有 `@cloudflare/workers-types` 里才有，为一个单文件
 * 代理往 lockfile 里加依赖不划算。这里只声明真正用到的那几个字段——与
 * `functions/amsg/[[path]].ts` 同一套做法。
 */
interface PagesContext {
  request: Request;
  env: Env;
}

/** 改这份脚本请顺手 +1：自检端点报出来，是唯一能确认「线上跑的是哪一版」的办法。 */
const PROXY_REVISION = 'mcp-pages-proxy-v1';

/** 自检：`/mcp-proxy?__health=1`。用 `__` 前缀，不会跟 `target` 撞。 */
const HEALTH_PARAM = '__health';

/**
 * 会转发给目标服务器的请求头白名单。
 *
 * 白名单而不是黑名单：这一层替用户的浏览器说话，多带一个头都可能把浏览器的身份
 * （Cookie、Referer、CF 的访客头）泄给第三方 MCP 服务器。
 */
const FORWARD_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'authorization',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
];

/**
 * 用户自定义头里**不许**出现的名字。
 *
 * 前五个是逐跳头或由 fetch 自己算的，透传过去只会让上游看到自相矛盾的报文；
 * 后两个是这一层自己的协议头，放行等于让调用方能借道改写代理的行为。
 */
const BLOCKED_FORWARD_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
  'x-proxy-key', 'x-mcp-forward-headers',
]);

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Proxy-Key, X-MCP-Forward-Headers',
  // 少了 Mcp-Session-Id 这一条，整个代理就白做了——握手拿不到 session id。
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
  'Access-Control-Max-Age': '86400',
};

/**
 * 从上游**照抄**回浏览器的响应头。
 *
 * 同样是白名单，而且刻意不含 `content-encoding` / `content-length`：fetch 拿到 gzip
 * 响应时已经自动解压，这两个头描述的却还是压缩前的状态，原样带回去浏览器会拿已经
 * 解开的 body 再解一次压，直接读失败（`functions/amsg/[[path]].ts` 踩过同一个坑）。
 */
const COPIED_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'www-authenticate', 'cache-control'];

const corsJson = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });

const isPrivateIpv4 = (host: string): boolean => {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
};

/**
 * 只允许公网 http/https 目标。
 *
 * 不拦的话，这个端点就成了一台架在 Cloudflare 网络里的内网探针：随便谁都能拿
 * `?target=http://10.0.0.1/` 让它替自己去敲那些从公网敲不到的地址。
 */
const blockedTargetReason = (rawUrl: string): string | null => {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return 'target 不是合法 URL'; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '只允许 http/https';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blocked = host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host === '::1'
    || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
    || isPrivateIpv4(host);
  return blocked ? '不允许代理内网/本机地址' : null;
};

export const onRequest = async (context: PagesContext): Promise<Response> => {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    const headers = new Headers(CORS_HEADERS);
    // 浏览器点名要放行哪些头就回哪些：MCP 客户端会带上用户自配的头名（X-API-Key
    // 之类），写死的那份清单列不全，漏一个 preflight 就挂。
    const requested = request.headers.get('access-control-request-headers');
    if (requested) headers.set('Access-Control-Allow-Headers', requested);
    return new Response(null, { status: 204, headers });
  }

  // 自检放在密钥校验之前：填错密钥时最需要的恰恰是「这一层到底部署了没」这个答案。
  // 只回一个版本号，不泄露任何配置——连密钥设没设都不说。
  if (url.searchParams.get(HEALTH_PARAM)) {
    return corsJson(200, { ok: true, revision: PROXY_REVISION });
  }

  if (env.MCP_PROXY_KEY) {
    if ((request.headers.get('x-proxy-key') || '') !== env.MCP_PROXY_KEY) {
      return corsJson(403, { error: '代理密钥错误（X-Proxy-Key）' });
    }
  }

  const target = url.searchParams.get('target');
  if (!target) return corsJson(400, { error: '缺少 ?target=<MCP服务器URL> 参数' });
  const blocked = blockedTargetReason(target);
  if (blocked) return corsJson(400, { error: blocked });

  const fwdHeaders = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) fwdHeaders.set(name, value);
  }
  // 用户在设置里加的自定义头（X-API-Key / XBY-APIKEY 这类非 Bearer 鉴权）：
  // 客户端把头名列在 X-MCP-Forward-Headers 里，这里据此只放行他明确配过的那几个。
  const customHeaderNames = (request.headers.get('x-mcp-forward-headers') || '')
    .split(',').map((name) => name.trim()).filter(Boolean);
  for (const name of customHeaderNames) {
    if (BLOCKED_FORWARD_HEADERS.has(name.toLowerCase())) continue;
    const value = request.headers.get(name);
    if (value) fwdHeaders.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: fwdHeaders,
      // body 流式透传，不缓冲：MCP 的响应可能是 SSE 长流，缓冲会把它整个卡住。
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
    } as RequestInit);
  } catch (error: any) {
    return corsJson(502, { error: `转发失败: ${error?.message || error}` });
  }

  const respHeaders = new Headers(CORS_HEADERS);
  for (const name of COPIED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) respHeaders.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
};
