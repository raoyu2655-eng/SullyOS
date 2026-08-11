/**
 * 文生图（生图 API）客户端。
 *
 * 角色在聊天里写 `[[SEND_IMAGE: 画面描述]]`，applyAssistantPostProcessing 把描述交给
 * 这里，调用户自己填的第三方生图接口出图，再当成一条 `image` 消息落库。
 *
 * 走 **OpenAI 兼容** 的 `POST {baseUrl}/images/generations`：
 *   { model, prompt, n: 1, size, response_format }
 *   → { data: [{ b64_json }] }  或  { data: [{ url }] }
 * DALL·E、硅基流动、one-api / new-api 这类中转站、以及大多数自建 SD 网关都是这个形状。
 * 服务商私有字段（steps / cfg_scale / negative_prompt…）用 extraBody 补。
 *
 * 为什么默认要 b64_json：URL 形态要前端再抓一次才能转成能长期存的 data URL，
 * 而图床多半不给 CORS，抓不动就只能把链接原样存进消息里——那种链接常常几小时后就过期，
 * 用户回头翻聊天记录看到的是一排裂图。b64_json 没有这两个问题。
 */
import type { APIConfig, ImageGenApiConfig } from '../types';

/**
 * 生图默认超时 —— 5 分钟。
 *
 * 定这么长是因为「超时太短」的代价比「等太久」大得多：那次生成在服务端照样跑完、
 * 照样计费，只是结果被我们自己扔了。gpt-image 高质量出图到 2-3 分钟是常事。
 *
 * 但也不能不设：生图是串在角色回复流程里的（applyAssistantPostProcessing 的
 * sendImageBubble 等着它），Promise 永远不落地就意味着不抛错、不落降级气泡、
 * 界面永远停在「正在自拍…」——退化成彻底的静默失败，比一句「等了 5 分钟没回应」糟得多。
 *
 * 用户可在「设置 → 生图 API → 高级选项」里按自己的服务商调。
 */
const DEFAULT_TIMEOUT_MS = 300_000;

/** 常用尺寸预设（设置页下拉用）。用户也可以手填任意 WxH。 */
export const IMAGE_SIZE_PRESETS: { value: string; label: string }[] = [
  { value: '512x512',   label: '512 × 512（方形 · 快）' },
  { value: '768x768',   label: '768 × 768（方形）' },
  { value: '1024x1024', label: '1024 × 1024（方形 · 常用）' },
  { value: '1024x1536', label: '1024 × 1536（竖图 2:3）' },
  { value: '1536x1024', label: '1536 × 1024（横图 3:2）' },
  { value: '1024x1792', label: '1024 × 1792（竖图 · DALL·E 3）' },
  { value: '1792x1024', label: '1792 × 1024（横图 · DALL·E 3）' },
];

export const DEFAULT_IMAGE_GEN_CONFIG: ImageGenApiConfig = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  size: '1024x1024',
  promptTemplate: '',
  negativePrompt: '',
  responseFormat: 'b64_json',
  extraBody: '',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  saveToGallery: true,
};

/** 超时输入框的可选范围（秒）。低于 30 秒基本必然误杀，高于 15 分钟等于没有。 */
export const IMAGE_TIMEOUT_MIN_S = 30;
export const IMAGE_TIMEOUT_MAX_S = 900;
export const IMAGE_TIMEOUT_DEFAULT_S = DEFAULT_TIMEOUT_MS / 1000;

/** 三个必填项齐了 + 开关打开才算「能用」。少一项都当没配。 */
export const isImageGenConfigured = (cfg?: ImageGenApiConfig | null): boolean =>
  !!(cfg?.enabled && cfg.baseUrl?.trim() && cfg.apiKey?.trim() && cfg.model?.trim());

/**
 * OpenAI 的 gpt-image 系（gpt-image-1 / gpt-image-2 / 中转站上的 `openai/gpt-image-*`）。
 *
 * 它跟 DALL·E 共用 `/images/generations` 这个地址，参数却更严：**多传一个不认识的字段
 * 就整个 400**（`Unknown parameter: 'response_format'`），不像多数中转站那样默默忽略。
 * 具体来说 `response_format` / `seed` / `negative_prompt` 它一个都不收——
 * 前者是因为它**固定**返回 b64_json，压根没有第二种形态可选。
 *
 * 所以这几个字段对它一律不发。用户在设置页填了也不发（填的时候没人知道会撞上这个），
 * 发了的结果是一次 400 + 一条 `[图片：…]` 降级文字，比悄悄少传一个参数糟得多。
 */
const isGptImageModel = (model: string): boolean =>
  /(^|[/:])gpt-image/i.test((model || '').trim());

/**
 * 模块级单例 —— 与 utils/ttsProvider.ts 的 ttsProvider / voicePromptOverrides 同一套思路。
 *
 * chatPrompts.buildSystemPrompt 拿不到 apiConfig，但它要决定「这一轮到底教不教角色
 * `[[SEND_IMAGE]]`」：没配生图却教了，角色就会写一个永远出不了图的标签，用户看到的是
 * 一行降级文字。OSContext 在 apiConfig.imageGenApi 变化时调 setImageGenConfig() 同步。
 */
let currentImageGenConfig: ImageGenApiConfig | null = null;

export function setImageGenConfig(cfg: ImageGenApiConfig | undefined | null): void {
  currentImageGenConfig = cfg && typeof cfg === 'object' ? cfg : null;
}

export function getImageGenConfig(): ImageGenApiConfig | null {
  return currentImageGenConfig;
}

/** prompt 侧的开关：这一轮该不该教角色写 `[[SEND_IMAGE]]`。 */
export const isImageGenEnabled = (): boolean => isImageGenConfigured(currentImageGenConfig);

/** 从 apiConfig 取生图配置（缺省 → null）。 */
export const resolveImageGenConfig = (
  apiConfig?: Pick<APIConfig, 'imageGenApi'> | null,
): ImageGenApiConfig | null => apiConfig?.imageGenApi ?? null;

/**
 * 拼最终送进生图模型的 prompt。
 * 模板含 `{prompt}` → 描述替换到那个位置；不含 → 当前缀拼在描述前面（用逗号连）。
 */
export function buildImagePrompt(description: string, cfg?: ImageGenApiConfig | null): string {
  const desc = (description || '').trim();
  const tpl = (cfg?.promptTemplate || '').trim();
  if (!tpl) return desc;
  if (tpl.includes('{prompt}')) return tpl.replace(/\{prompt\}/g, desc).trim();
  return desc ? `${tpl}, ${desc}` : tpl;
}

/**
 * 把 data URL 还原成能塞进 FormData 的 File。
 *
 * 参考图是以 data URL 存在角色档案里的（跟头像 / 聊天图片同一套），而
 * `/images/edits` 收的是 multipart 文件字段，中间必须过一道这个转换。
 */
export function dataUrlToFile(dataUrl: string, filename = 'reference.png'): File {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!m) throw new Error('参考图不是合法的 data URL');
  const mime = m[1] || 'image/png';
  const isBase64 = !!m[2];
  const raw = isBase64 ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  return new File([bytes], filename.replace(/\.\w+$/, '') + '.' + ext, { type: mime });
}

export interface GenerateImageResult {
  /** 可以直接塞进 <img src> 的地址：data:image/...;base64,... 或（兜底时）远端链接。 */
  content: string;
  /** true = content 是远端链接而非 data URL（可能过期）。 */
  isRemoteUrl: boolean;
  /** 实际送进模型的 prompt（拼过模板的），存进消息 metadata 便于排查。 */
  finalPrompt: string;
  /** 有些服务端（DALL·E 3）会改写 prompt 后回传。 */
  revisedPrompt?: string;
}

export interface GenerateImageOptions {
  signal?: AbortSignal;
  /** 覆盖配置里的尺寸（留给「重新生成时换个比例」这类调用方）。 */
  size?: string;
  /**
   * 固定随机种子（角色自拍用，见 CharacterProfile.imageGen.seed）。
   * 传了就随请求体发出去；SD 系模型认它，DALL·E 3 会忽略。
   */
  seed?: number;
  /**
   * 「锁脸」参考图（data URL，见 CharacterProfile.imageGen.faceRef）。
   *
   * 有它就改走 `POST {baseUrl}/images/edits`（multipart），让模型照着这张脸画新图 ——
   * 这是纯文字描述做不到的那一层一致性：文字只能说「银发红瞳」，模型每次自己想象一张脸；
   * 参考图是真的看着同一张脸画。
   *
   * 不是所有服务商都代理这个端点（很多中转站只转发 /images/generations），
   * 所以调用方要准备好接住失败并回落到纯文字那条路。
   */
  referenceImage?: string;
}

/**
 * 自拍提示词：角色的固定外貌 + 模型现写的场景/动作/表情。
 *
 * 外貌放最前面 —— 生图模型普遍对提示词前段权重更高，把长相压在一堆场景词后面
 * 容易被稀释成路人。`selfie` 这个词也一并前置，否则模型常画成第三人称的人物立绘。
 */
export function buildSelfiePrompt(appearance: string, scene: string): string {
  const look = (appearance || '').trim().replace(/[,，。;；\s]+$/, '');
  const what = (scene || '').trim();
  if (!look) return what;
  return what ? `selfie photo, ${look}, ${what}` : `selfie photo, ${look}`;
}

/**
 * Blob → data URL。
 *
 * 走 arrayBuffer + btoa 而不是 FileReader：FileReader 是 DOM API，worker / node 侧都没有，
 * 用它的话这条分支只能在浏览器里跑（连测试都摸不到，一直静默走「抓不回来」的兜底）。
 */
const blobToDataUrl = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // 分块拼 —— String.fromCharCode(...整个数组) 在 1MB 以上的图上会爆调用栈，
  // 而生图出来的正是这个量级。
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
};

/** 从返回里挖出第一张图。兼容 OpenAI 形状和几种常见变体。 */
const extractImagePayload = (data: any): { b64?: string; url?: string; revised?: string } => {
  // OpenAI 标准：{ data: [{ b64_json | url, revised_prompt }] }
  const first = Array.isArray(data?.data) ? data.data[0]
    // 部分中转站直接给 { images: [...] }（SD WebUI 风格）
    : Array.isArray(data?.images) ? data.images[0]
    : undefined;

  if (typeof first === 'string') {
    // { images: ["<base64>"] } 或 { images: ["https://..."] }
    return /^https?:\/\//i.test(first) ? { url: first } : { b64: first };
  }
  if (first && typeof first === 'object') {
    return {
      b64: typeof first.b64_json === 'string' ? first.b64_json
        : typeof first.b64 === 'string' ? first.b64 : undefined,
      url: typeof first.url === 'string' ? first.url : undefined,
      revised: typeof first.revised_prompt === 'string' ? first.revised_prompt : undefined,
    };
  }
  // 少数服务端把单图直接放顶层
  if (typeof data?.url === 'string') return { url: data.url };
  if (typeof data?.b64_json === 'string') return { b64: data.b64_json };
  return {};
};

/** base64 前几个字节能认出格式；认不出按 png 处理（<img> 对 MIME 不敏感，但存相册要一个像样的值）。 */
const sniffMimeFromBase64 = (b64: string): string => {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
};

/**
 * 调生图接口出一张图。
 *
 * 失败一律 throw（带中文可读原因），调用方决定是降级成文字气泡还是弹 toast。
 */
export async function generateImage(
  description: string,
  cfg: ImageGenApiConfig,
  options: GenerateImageOptions = {},
): Promise<GenerateImageResult> {
  if (!isImageGenConfigured(cfg)) {
    throw new Error('生图 API 没配全（需要 baseUrl + Key + 模型，且开关打开）');
  }
  const finalPrompt = buildImagePrompt(description, cfg);
  if (!finalPrompt) throw new Error('生图提示词是空的');

  const base = cfg.baseUrl.trim().replace(/\/+$/, '');
  // 用户常把整条 /v1/images/generations 粘进来；照原样再拼一次就成了 .../generations/images/generations。
  const root = base.replace(/\/images\/(?:generations|edits)$/i, '');

  const size = (options.size ?? cfg.size ?? '').trim();
  const responseFormat = cfg.responseFormat ?? 'b64_json';
  // gpt-image 系对多余字段是硬报错而不是忽略，见 isGptImageModel。
  const gptImage = isGptImageModel(cfg.model);
  const reference = (options.referenceImage || '').trim();

  // ── 锁脸分支：有参考图就走 /images/edits（multipart），让模型照着这张脸画 ──
  if (reference) {
    return await generateWithReference({
      root, cfg, finalPrompt, size, reference, gptImage,
      responseFormat, signal: options.signal,
    });
  }

  const endpoint = `${root}/images/generations`;

  const body: Record<string, any> = {
    model: cfg.model.trim(),
    prompt: finalPrompt,
    n: 1,
  };
  if (size) body.size = size;
  if (!gptImage && responseFormat !== 'auto') body.response_format = responseFormat;
  const negative = (cfg.negativePrompt || '').trim();
  if (negative && !gptImage) body.negative_prompt = negative;
  // 0 是合法种子，别用 truthy 判断把它吃掉。
  if (!gptImage && typeof options.seed === 'number' && Number.isFinite(options.seed)) body.seed = options.seed;

  if (gptImage) {
    const dropped = [
      responseFormat !== 'auto' ? 'response_format' : '',
      negative ? 'negative_prompt' : '',
      typeof options.seed === 'number' ? 'seed' : '',
    ].filter(Boolean);
    if (dropped.length) {
      console.info(`[ImageGen] ${cfg.model} 是 gpt-image 系，不支持 ${dropped.join(' / ')}，这几个字段本次不发送`);
    }
  }

  // extraBody 里用户写的字段优先级最高——他们填这个就是为了覆盖上面的默认。
  if (cfg.extraBody?.trim()) {
    try {
      const extra = JSON.parse(cfg.extraBody);
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(body, extra);
    } catch (e) {
      console.warn('[ImageGen] extraBody 不是合法 JSON，已忽略:', e);
    }
  }

  // 用户传进来的 signal 和超时定时器合并成一个：任一触发都要真的中止请求。
  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  // abort 一定要带 reason —— 不带的话浏览器只报「signal is aborted without reason」，
  // App 的网络诊断会把它读成「用户手动点了停止」，把排查方向直接带偏。
  const timer = setTimeout(() => controller.abort(timeoutReason(timeoutMs, '生图')), timeoutMs);
  const onOuterAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e: any) {
    // 调用方自己撤的（切页面 / 组件卸载）——原样抛，不要伪装成超时。
    if (options.signal?.aborted) throw e;
    // 我们自己的超时。abort 带了 reason 后错误名是 TimeoutError；不带 reason 的老路径是 AbortError，一并认。
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(
        `生图超时：等了 ${Math.round(timeoutMs / 1000)} 秒服务端一个字节都没回，由客户端中止。`
        + '（不是你点了停止。这种形态多半是中转站那头卡住了——图可能已经生成并计费。换一家中转站试试。）'
      );
    }
    throw new Error(`连不上生图接口：${e?.message || e}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }

  return await parseImageResponse(res, finalPrompt, options.signal);
}

/**
 * 两个端点（generations / edits）共用的响应处理：报错措辞、b64 / url 两种形态、
 * URL 抓不回来时的兜底。抽出来是为了让锁脸那条路和纯文字那条路的行为**完全一致** ——
 * 分两份写的话，「图床跨域退回存链接」这类边角逻辑迟早只在一边生效。
 */
async function parseImageResponse(
  res: Response,
  finalPrompt: string,
  signal?: AbortSignal,
): Promise<GenerateImageResult> {
  const rawText = await res.text();

  // 空响应体单独拎出来说 —— 这是中转站最坑的一种坏法：状态码给 200、后台记一次成功调用、
  // 钱也扣了，却一个字节都不回。落到通用的「返回的不是 JSON」上，报错尾巴是空的，
  // 用户只会以为是自己参数填错，然后一遍遍重试、一遍遍扣费。
  // 这种情况客户端无解（图确实生成了，只是没传回来），只能明说是服务端的问题。
  if (!rawText.trim()) {
    throw new Error(
      `生图接口返回了空响应（HTTP ${res.status}，0 字节）。`
      + '图很可能已经生成并计费了，只是没传回来——这是中转站那头的问题，换参数或重试都解决不了。'
      + '建议联系服务商，或换一家中转站。'
    );
  }

  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`生图接口返回的不是 JSON (HTTP ${res.status}): ${rawText.slice(0, 200)}`);
  }
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || data?.detail || rawText.slice(0, 200);
    // 「多传了一个它不认识的字段」是这类接口最常见的失败，而原始报错只会甩一个参数名，
    // 用户不知道那是哪来的（多半是设置页某个可选项，或者自己填的附加参数 JSON）。
    // 顺手把话说到「去哪儿改」这一层。
    const unknownParam = /unknown\s+parameter|unsupported\s+parameter|unrecognized|extra fields|not permitted/i.test(String(detail));
    const hint = unknownParam
      ? '（这个模型不认识请求里的某个字段——去「设置 → 生图 API → 高级选项」把「返回格式」改成「不指定」、清空「负向提示词」和「附加参数」再试）'
      : /size/i.test(String(detail)) && res.status === 400
        ? '（多半是图片尺寸这个模型不支持，换一个尺寸预设试试）'
        : '';
    throw new Error(`生图失败 (HTTP ${res.status}): ${detail}${hint}`);
  }

  const { b64, url, revised } = extractImagePayload(data);

  if (b64) {
    // 有的服务端已经把 data: 前缀带上了，别重复拼。
    const content = b64.startsWith('data:') ? b64 : `data:${sniffMimeFromBase64(b64)};base64,${b64}`;
    return { content, isRemoteUrl: false, finalPrompt, revisedPrompt: revised };
  }

  if (url) {
    // 抓回来转 data URL，这样图片跟着聊天记录一起存、一起备份，不怕链接过期。
    // 图床基本不给 CORS，抓不动是常态 —— 那就退回存链接：能显示多久算多久，
    // 总比整条消息没有图强（设置页会提示这个风险）。
    try {
      const fileRes = await fetch(url, { signal });
      if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);
      const blob = await fileRes.blob();
      if (!blob.size) throw new Error('下载到的是空文件');
      return { content: await blobToDataUrl(blob), isRemoteUrl: false, finalPrompt, revisedPrompt: revised };
    } catch (e) {
      console.warn('[ImageGen] 图片链接抓不回来（多半是跨域），改为直接存链接，可能会过期:', e);
      return { content: url, isRemoteUrl: true, finalPrompt, revisedPrompt: revised };
    }
  }

  throw new Error(`生图接口没返回图片数据：${rawText.slice(0, 200)}`);
}

/**
 * 超时中止时带上的 reason。
 *
 * `controller.abort()` 不带参数时，浏览器给的是「signal is aborted without reason」——
 * App 的网络诊断只能把它归类成「调用方自己撤了 / 用户点了停止」，于是排查方向被带去
 * 「是不是切页面了」，而真相是这次请求挂满了超时上限。带上 reason 就能直接看出是谁掐的。
 */
const timeoutReason = (ms: number, what: string): DOMException =>
  new DOMException(`${what}超时：等了 ${Math.round(ms / 1000)} 秒仍未收到响应，由客户端主动中止`, 'TimeoutError');

/** 服务商没代理 /images/edits 时抛这个，调用方据此回落到纯文字生图。 */
export class ReferenceUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferenceUnsupportedError';
  }
}

/**
 * 锁脸：`POST {root}/images/edits`（multipart），照着参考图画新图。
 *
 * 这个端点的支持面比 /images/generations 窄得多 —— 很多中转站压根没代理它。
 * 404 / 405 / "not found" 一律翻译成 ReferenceUnsupportedError，让调用方
 * 安静地回落到纯文字那条路：锁脸只是锦上添花，不该因为它把原本能出的图弄没了。
 */
async function generateWithReference(args: {
  root: string;
  cfg: ImageGenApiConfig;
  finalPrompt: string;
  size: string;
  reference: string;
  gptImage: boolean;
  responseFormat: 'b64_json' | 'url' | 'auto';
  signal?: AbortSignal;
}): Promise<GenerateImageResult> {
  const { root, cfg, finalPrompt, size, reference, gptImage, responseFormat, signal } = args;
  const endpoint = `${root}/images/edits`;

  const form = new FormData();
  form.append('model', cfg.model.trim());
  form.append('prompt', finalPrompt);
  form.append('n', '1');
  if (size) form.append('size', size);
  // gpt-image 固定回 b64_json 且不收这个字段；其余服务商照发（DALL·E 2 edits 认它）。
  if (!gptImage && responseFormat !== 'auto') form.append('response_format', responseFormat);
  form.append('image', dataUrlToFile(reference, 'face-ref'));

  // 注意：**不要**手写 Content-Type。multipart 需要 boundary，浏览器会自己带上；
  // 手写会漏掉 boundary，服务端直接解析失败。
  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutReason(timeoutMs, '锁脸生图')), timeoutMs);
  const onOuterAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.apiKey.trim()}` },
      body: form,
      signal: controller.signal,
    });
  } catch (e: any) {
    if (signal?.aborted) throw e;
    // 超时不能算「不支持参考图」——那会让调用方安静回落，把一个链路故障掩盖成功能缺失。
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`锁脸生图超时：等了 ${Math.round(timeoutMs / 1000)} 秒服务端没有响应（不是你点了停止）。`);
    }
    throw new ReferenceUnsupportedError(`连不上 /images/edits：${e?.message || e}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }

  if (res.status === 404 || res.status === 405 || res.status === 501) {
    throw new ReferenceUnsupportedError(`这个 API 没有提供 /images/edits（HTTP ${res.status}）`);
  }

  return await parseImageResponse(res, finalPrompt, signal);
}

/**
 * 探测：这个 API 到底转不转发 /images/edits。
 *
 * 故意发一张 1x1 的小图 —— 只为看端点在不在，不为出图。返回 'ok' 说明真出了图；
 * 'unsupported' 说明端点不存在（中转站没代理）；'error' 是别的失败（额度 / 鉴权 /
 * 尺寸不合法之类），这类不能算「不支持」，否则用户会以为功能用不了而放弃。
 */
export async function probeReferenceSupport(
  cfg: ImageGenApiConfig,
  signal?: AbortSignal,
): Promise<{ status: 'ok' | 'unsupported' | 'error'; detail: string }> {
  if (!isImageGenConfigured(cfg)) return { status: 'error', detail: '生图 API 没配全' };
  // 1x1 透明 PNG
  const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  try {
    await generateImage('a small red dot', cfg, { referenceImage: tiny, signal });
    return { status: 'ok', detail: '支持参考图，锁脸可用' };
  } catch (e: any) {
    if (e?.name === 'ReferenceUnsupportedError') {
      return { status: 'unsupported', detail: e.message };
    }
    return { status: 'error', detail: e?.message || String(e) };
  }
}
