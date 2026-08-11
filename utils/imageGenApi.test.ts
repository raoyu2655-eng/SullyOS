import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildImagePrompt,
  generateImage,
  isImageGenConfigured,
  isImageGenEnabled,
  setImageGenConfig,
  DEFAULT_IMAGE_GEN_CONFIG,
} from './imageGenApi';
import { ChatParser } from './chatParser';
import type { ImageGenApiConfig } from '../types';

const cfg = (over: Partial<ImageGenApiConfig> = {}): ImageGenApiConfig => ({
  ...DEFAULT_IMAGE_GEN_CONFIG,
  enabled: true,
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-image-model',
  ...over,
});

// 1x1 透明 PNG 的 base64，够短且首字节能被 sniffMimeFromBase64 认出来。
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('isImageGenConfigured', () => {
  it('三项齐 + 开关开 → true', () => {
    expect(isImageGenConfigured(cfg())).toBe(true);
  });

  it('开关关 → false（配全了也不算能用）', () => {
    expect(isImageGenConfigured(cfg({ enabled: false }))).toBe(false);
  });

  it.each([
    ['baseUrl', { baseUrl: '' }],
    ['apiKey', { apiKey: '  ' }],
    ['model', { model: '' }],
  ])('缺 %s → false', (_name, over) => {
    expect(isImageGenConfigured(cfg(over as Partial<ImageGenApiConfig>))).toBe(false);
  });

  it('null / undefined → false', () => {
    expect(isImageGenConfigured(null)).toBe(false);
    expect(isImageGenConfigured(undefined)).toBe(false);
  });
});

describe('单例（chatPrompts 靠它决定教不教 [[SEND_IMAGE]]）', () => {
  afterEach(() => setImageGenConfig(null));

  it('setImageGenConfig 后 isImageGenEnabled 跟着变', () => {
    expect(isImageGenEnabled()).toBe(false);
    setImageGenConfig(cfg());
    expect(isImageGenEnabled()).toBe(true);
    setImageGenConfig(cfg({ enabled: false }));
    expect(isImageGenEnabled()).toBe(false);
  });
});

describe('buildImagePrompt', () => {
  it('没模板 → 原样用角色写的描述', () => {
    expect(buildImagePrompt('一只猫', cfg({ promptTemplate: '' }))).toBe('一只猫');
  });

  it('模板含 {prompt} → 替换到该位置', () => {
    expect(buildImagePrompt('一只猫', cfg({ promptTemplate: 'best quality, {prompt}, 日系插画' })))
      .toBe('best quality, 一只猫, 日系插画');
  });

  it('模板不含 {prompt} → 当前缀拼在描述前', () => {
    expect(buildImagePrompt('一只猫', cfg({ promptTemplate: 'masterpiece' })))
      .toBe('masterpiece, 一只猫');
  });

  it('描述为空但有模板 → 只用模板（不留下孤零零的逗号）', () => {
    expect(buildImagePrompt('  ', cfg({ promptTemplate: 'masterpiece' }))).toBe('masterpiece');
  });
});

describe('generateImage', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const jsonRes = (body: unknown, ok = true, status = 200) => ({
    ok,
    status,
    text: async () => JSON.stringify(body),
  });

  it('b64_json → 拼成 data URL', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
    const result = await generateImage('一只猫', cfg());
    expect(result.isRemoteUrl).toBe(false);
    expect(result.content).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('baseUrl 末尾自动补 /images/generations，请求体带 model / size / n', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
    await generateImage('一只猫', cfg({ size: '1024x1024' }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/images/generations');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'test-image-model', size: '1024x1024', n: 1, response_format: 'b64_json' });
    expect(init.headers.Authorization).toBe('Bearer sk-test');
  });

  it('用户把整条 /images/generations 粘进 baseUrl → 不重复拼', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
    await generateImage('一只猫', cfg({ baseUrl: 'https://api.example.com/v1/images/generations' }));
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/images/generations');
  });

  it('size 留空 → 不传 size 字段（用服务端默认，而不是发一个空字符串）', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
    await generateImage('一只猫', cfg({ size: '' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('size');
  });

  it("responseFormat: 'auto' → 不传 response_format", async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
    await generateImage('一只猫', cfg({ responseFormat: 'auto' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('response_format');
  });

  it('extraBody 合并进请求体，同名字段覆盖默认', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
    await generateImage('一只猫', cfg({ extraBody: '{"steps":20,"size":"512x512"}' }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.steps).toBe(20);
    expect(body.size).toBe('512x512');
  });

  it('extraBody 是坏 JSON → 忽略它，请求照发', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
    await expect(generateImage('一只猫', cfg({ extraBody: '{坏的' }))).resolves.toBeTruthy();
  });

  it('模板拼过的 prompt 才是送出去的那份', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
    const result = await generateImage('一只猫', cfg({ promptTemplate: 'best quality, {prompt}' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toBe('best quality, 一只猫');
    expect(result.finalPrompt).toBe('best quality, 一只猫');
  });

  it('URL 形态且抓得回来 → 转成 data URL', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: [{ url: 'https://cdn.example.com/a.png' }] }))
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(['x'], { type: 'image/png' }) });
    const result = await generateImage('一只猫', cfg({ responseFormat: 'url' }));
    expect(result.isRemoteUrl).toBe(false);
    expect(result.content.startsWith('data:')).toBe(true);
  });

  it('URL 形态但跨域抓不回来 → 退回存链接并标记 isRemoteUrl', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: [{ url: 'https://cdn.example.com/a.png' }] }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const result = await generateImage('一只猫', cfg({ responseFormat: 'url' }));
    expect(result).toMatchObject({ isRemoteUrl: true, content: 'https://cdn.example.com/a.png' });
  });

  it('HTTP 错误 → 抛出带服务端 message 的中文错误', async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: { message: 'insufficient balance' } }, false, 402));
    await expect(generateImage('一只猫', cfg())).rejects.toThrow(/402.*insufficient balance/);
  });

  it('返回里没有图 → 抛错而不是发一条空图片', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [] }));
    await expect(generateImage('一只猫', cfg())).rejects.toThrow(/没返回图片/);
  });

  it('没配全 → 直接抛错，不打请求（不白烧一次额度）', async () => {
    await expect(generateImage('一只猫', cfg({ model: '' }))).rejects.toThrow(/没配全/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// splitResponse 是 [[SEND_IMAGE]] 进入渲染管线的唯一入口 —— 顺序错了就是
// 「角色先发图后说话」变成「先说话后发图」，漏了就是整条消息没有图。
describe('splitResponse: [[SEND_IMAGE]]', () => {
  it('拆出 image part，描述被 trim', () => {
    expect(ChatParser.splitResponse('你看这个\n[[SEND_IMAGE:  窗台上的猫  ]]')).toEqual([
      { type: 'text', content: '你看这个' },
      { type: 'image', content: '窗台上的猫' },
    ]);
  });

  it('图和表情混排时保持模型写的先后顺序', () => {
    expect(ChatParser.splitResponse('喏[[SEND_IMAGE: 晚饭]]好吃吧[[SEND_EMOJI: 得意]]')).toEqual([
      { type: 'text', content: '喏' },
      { type: 'image', content: '晚饭' },
      { type: 'text', content: '好吃吧' },
      { type: 'emoji', content: '得意' },
    ]);
  });

  it('全角冒号（中文输入法下的高频手写变体）也认', () => {
    expect(ChatParser.splitResponse('[[SEND_IMAGE：一只猫]]')).toEqual([
      { type: 'image', content: '一只猫' },
    ]);
  });

  it('描述为空 → 整个丢掉（空 prompt 调生图只会白烧额度）', () => {
    expect(ChatParser.splitResponse('前面[[SEND_IMAGE: ]]后面')).toEqual([
      { type: 'text', content: '前面' },
      { type: 'text', content: '后面' },
    ]);
  });

  it('漏写闭合的标签不会吞掉后面的正文', () => {
    // `[^\]]*?` 的作用：换成 `[\s\S]*?` 的话这里会一路吞到下一个 `]]`，
    // 把「我今天」整段吃成图片描述。
    const parts = ChatParser.splitResponse('[[SEND_IMAGE: 没闭合\n我今天很累[[SEND_EMOJI: 累]]');
    expect(parts.some(p => p.type === 'image')).toBe(false);
    expect(parts.find(p => p.type === 'emoji')?.content).toBe('累');
  });

  it('没有任何标签时行为不变', () => {
    expect(ChatParser.splitResponse('就是一句普通的话')).toEqual([
      { type: 'text', content: '就是一句普通的话' },
    ]);
  });
});
