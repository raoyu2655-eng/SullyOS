/**
 * amsg 的 Pages Functions 门面 —— 给 Cloudflare worker 换一个国内能直连的地址。
 *
 * 背景：主动消息的 worker 跑在 `*.workers.dev` 上，那个域名在国内经常连不上
 * （表现是请求挂几十秒、一个字节都没收到）。仓库里原有的解法是
 * `public/amsg-deno-proxy.ts`——部署到 Deno Deploy 换一个域名。但 Deno 的控制台
 * 本身在国内也可能连不上，那条路就走不通了（实测：`console.deno.com` 打不开）。
 *
 * 这一份换个思路：**门面就架在本站自己身上**。SullyOS 部署在 Pages 上，用户既然
 * 能打开这个站，这个域名对他就是可达的——拿它当门面是零风险的选择，不用注册任何
 * 新服务，也不用再赌第三个域名通不通。而且它跟着前端一起部署，推代码就生效。
 *
 * 路由：`https://<你的站>/amsg/*` → `https://<你的 worker>/*`
 * 用法：把 SullyOS「设置 → 主动消息 → Worker 地址」填成 `https://<你的站>/amsg`
 *      （客户端 normalizeWorkerBase 只去尾斜杠，带路径前缀是支持的）。
 *
 * 上游地址从环境变量 `AMSG_UPSTREAM` 读，在 Pages 项目的
 * Settings → Environment variables 里配。不配就返回 503 并说明原因——
 * 与其闷头往一个不存在的域名转发，不如直接说清楚。
 *
 * 两件值得先知道的事：
 *   - **推送不走这条路。** worker 是直接把消息发给 FCM / APNs 的，跟浏览器怎么
 *     访问 worker 是两条独立的路。所以这层挂了不影响收消息，只影响改配置。
 *   - **数据没有搬家。** 业务逻辑、D1、Cron 全都还在 Cloudflare worker 上，
 *     这一层不存任何数据、不认任何业务端点。
 */

interface Env {
  /** 你的 Cloudflare amsg worker 地址，如 https://sullyos-amsg.xxx.workers.dev */
  AMSG_UPSTREAM?: string;
}

/**
 * Pages Functions 的运行时类型只有 `@cloudflare/workers-types` 里才有，而为一个
 * 单文件门面往 lockfile 里加依赖不划算（还会跟上游的 lockfile 冲突）。这里只声明
 * 这份文件真正用到的那几个字段——跟 amsg-deno-proxy.ts 里 `declare const Deno`
 * 是同一套做法。
 */
interface PagesContext {
  request: Request;
  env: Env;
  params: Record<string, string | string[]>;
}

/** 本层自检端点。amsg 的端点都是 `/init-tenant` 这种单词形式，不会跟双下划线撞车。 */
const HEALTH_PATH = '__proxy-health';

/** 改这份脚本请顺手 +1：自检端点报出来，是唯一能确认「线上跑的是哪一版」的办法。 */
const PROXY_REVISION = 'amsg-pages-proxy-v1';

/**
 * 转发响应时必须摘掉的头（与 amsg-deno-proxy.ts 同一份清单，理由也一样）。
 *
 * 前四个是逐跳（hop-by-hop）头：只描述「这一段 TCP 连接」，跨代理带过去没有意义。
 * `content-encoding` / `content-length` 是更要命的一对——fetch 拿到 gzip 响应时会
 * 自动解压，但这两个头描述的还是压缩前的状态。原样带回浏览器的话，浏览器会拿已经
 * 解开的 body 再解一次压，直接读失败。
 */
const STRIPPED_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
];

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export const onRequest = async (context: PagesContext): Promise<Response> => {
  const { request, env, params } = context;

  // `[[path]]` 捕获的是 /amsg 之后那一段；catch-all 给的是数组。
  const rest = Array.isArray(params.path) ? params.path.join('/') : (params.path || '');
  const upstream = (env.AMSG_UPSTREAM || '').trim().replace(/\/+$/, '');

  if (rest === HEALTH_PATH) {
    return json({
      ok: !!upstream,
      revision: PROXY_REVISION,
      upstreamConfigured: !!upstream,
      // 只回域名，不回完整地址——这个端点是公开的，没必要把上游全路径摊开。
      upstreamHost: upstream ? new URL(upstream).host : null,
      hint: upstream
        ? '门面正常。把 SullyOS 的 Worker 地址填成本站的 /amsg 即可。'
        : '还没配上游：去 Pages 项目 Settings → Environment variables 加一个 AMSG_UPSTREAM，值是你的 worker 地址，然后重新部署一次。',
    }, upstream ? 200 : 503);
  }

  if (!upstream) {
    return json({
      error: 'AMSG_UPSTREAM 没配置',
      hint: '去 Pages 项目 Settings → Environment variables 加 AMSG_UPSTREAM（你的 worker 地址），然后重新部署一次。',
    }, 503);
  }

  const incoming = new URL(request.url);
  const target = new URL(upstream);
  // 上游地址允许带路径前缀（少见但合法），拼接时别把它吃掉。
  target.pathname = `${target.pathname.replace(/\/+$/, '')}/${rest}`.replace(/\/{2,}/g, '/');
  target.search = incoming.search;

  const headers = new Headers(request.headers);
  // host 交给 fetch 按目标地址自己填，否则上游会收到本站的 host。
  headers.delete('host');
  // 压缩协商也交给 fetch 自己做：浏览器会要 zstd，而 fetch 只自动解开它协商的那几种，
  // 原样转过去会导致 body 还是压缩态、下面又按「已解开」摘掉 content-encoding，
  // 出口再压一层——浏览器解完外层拿到的还是压缩数据，页面上就是一片乱码。
  headers.delete('accept-encoding');

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const init: RequestInit & { duplex?: string } = {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    // 上游返回 3xx 时不要自动跟过去，原样交给浏览器判断。
    redirect: 'manual',
  };
  // 流式转发请求体（配置上云可能不小）时，fetch 标准要求显式声明 duplex。
  if (hasBody) init.duplex = 'half';

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(target.toString(), init as RequestInit);
  } catch (error) {
    // 门面自己活着、够不着上游——说清是哪一段断的，别让用户又去查自己的网络。
    return json({
      error: '门面连不上上游 worker',
      upstreamHost: target.host,
      detail: (error as Error)?.message || String(error),
      hint: 'worker 可能被删了、地址填错了，或 Cloudflare 内部出网异常。先直接访问 worker 的 /config-check 确认它还活着。',
    }, 502);
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) responseHeaders.delete(name);
  // body 原样透传（不 await text()）——即时对话有流式响应，缓冲会把逐字效果压成一次性吐出。
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
};
