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

/** 生图默认超时：文生图普遍比对话慢得多，SD 类服务冷启动几十秒是常态。 */
const DEFAULT_TIMEOUT_MS = 120_000;

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

/** 三个必填项齐了 + 开关打开才算「能用」。少一项都当没配。 */
export const isImageGenConfigured = (cfg?: ImageGenApiConfig | null): boolean =>
  !!(cfg?.enabled && cfg.baseUrl?.trim() && cfg.apiKey?.trim() && cfg.model?.trim());

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
  const endpoint = /\/images\/generations$/i.test(base) ? base : `${base}/images/generations`;

  const size = (options.size ?? cfg.size ?? '').trim();
  const responseFormat = cfg.responseFormat ?? 'b64_json';

  const body: Record<string, any> = {
    model: cfg.model.trim(),
    prompt: finalPrompt,
    n: 1,
  };
  if (size) body.size = size;
  if (responseFormat !== 'auto') body.response_format = responseFormat;
  const negative = (cfg.negativePrompt || '').trim();
  if (negative) body.negative_prompt = negative;

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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
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
    if (options.signal?.aborted) throw e;
    if (e?.name === 'AbortError') throw new Error(`生图超时（>${Math.round(timeoutMs / 1000)} 秒）`);
    throw new Error(`连不上生图接口：${e?.message || e}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }

  const rawText = await res.text();
  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`生图接口返回的不是 JSON (HTTP ${res.status}): ${rawText.slice(0, 200)}`);
  }
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || data?.detail || rawText.slice(0, 200);
    throw new Error(`生图失败 (HTTP ${res.status}): ${detail}`);
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
      const fileRes = await fetch(url, { signal: options.signal });
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
