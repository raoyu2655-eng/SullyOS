import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildImagePrompt,
  buildSelfiePrompt,
  dataUrlToFile,
  probeReferenceSupport,
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

// 自拍的一致性全靠「外貌由固定文本负责、模型只写场景」这条分工。
// 外貌被挤到提示词末尾、或者模型自己写的场景把它冲掉，画出来就是另一个人。
describe('buildSelfiePrompt', () => {
  it('外貌前置 + selfie 关键词打头（生图模型对提示词前段权重更高）', () => {
    expect(buildSelfiePrompt('1girl, 银色长发, 红瞳', '窝在沙发上比耶'))
      .toBe('selfie photo, 1girl, 银色长发, 红瞳, 窝在沙发上比耶');
  });

  it('场景为空 → 只有外貌，不留孤零零的逗号（能出一张纯人像）', () => {
    expect(buildSelfiePrompt('1girl, 银色长发', '')).toBe('selfie photo, 1girl, 银色长发');
  });

  it('外貌末尾的中英文标点被吃掉，不会拼成 "红瞳，, 场景"', () => {
    expect(buildSelfiePrompt('1girl, 红瞳。', '在厨房')).toBe('selfie photo, 1girl, 红瞳, 在厨房');
    expect(buildSelfiePrompt('1girl, 红瞳, ', '在厨房')).toBe('selfie photo, 1girl, 红瞳, 在厨房');
  });

  it('没填外貌 → 退回纯场景（调用方会据此退化成普通生图）', () => {
    expect(buildSelfiePrompt('', '在厨房')).toBe('在厨房');
    expect(buildSelfiePrompt('   ', '在厨房')).toBe('在厨房');
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

  it('传了 seed → 进请求体（自拍一致性靠它）', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
    await generateImage('一只猫', cfg(), { seed: 12345 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).seed).toBe(12345);
  });

  it('seed 为 0 也要发出去（0 是合法种子，别被 truthy 判断吃掉）', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
    await generateImage('一只猫', cfg(), { seed: 0 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).seed).toBe(0);
  });

  it('没传 seed → 不带 seed 字段（普通照片每张都该不一样）', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
    await generateImage('一只猫', cfg());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('seed');
  });

  // gpt-image 系多传一个不认识的字段就整个 400（不像多数中转站会忽略），
  // 所以这三个字段对它必须一个都不发 —— 否则用户配好了也是一次报错 + 一条降级文字。
  describe('gpt-image 兼容', () => {
    it.each(['gpt-image-1', 'gpt-image-2', 'openai/gpt-image-2'])(
      '%s → 不发 response_format / seed / negative_prompt',
      async (model) => {
        fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
        await generateImage('一只猫', cfg({ model, negativePrompt: 'lowres', responseFormat: 'b64_json' }), { seed: 42 });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('response_format');
        expect(body).not.toHaveProperty('seed');
        expect(body).not.toHaveProperty('negative_prompt');
        // 该发的还得发
        expect(body).toMatchObject({ model, n: 1, prompt: '一只猫' });
      },
    );

    it('非 gpt-image 的模型不受影响（照发这三个字段）', async () => {
      fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
      await generateImage('一只猫', cfg({ model: 'dall-e-3', negativePrompt: 'lowres' }), { seed: 42 });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.response_format).toBe('b64_json');
      expect(body.seed).toBe(42);
      expect(body.negative_prompt).toBe('lowres');
    });

    it('名字里带 image 但不是 gpt-image 的别误伤（如 flux-image）', async () => {
      fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
      await generateImage('一只猫', cfg({ model: 'flux-image-pro' }), { seed: 7 });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).seed).toBe(7);
    });
  });

  // 锁脸：有参考图就改走 /images/edits（multipart）。这条路的关键约束是
  // 「不支持时必须安静回落」—— 锁脸是锦上添花，不该因为它把原本能出的图弄没。
  describe('锁脸（参考图）', () => {
    const TINY = 'data:image/png;base64,' + PNG_B64;

    it('传了参考图 → 打 /images/edits，且用 multipart 而不是 JSON', async () => {
      fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
      await generateImage('在厨房', cfg(), { referenceImage: TINY });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.example.com/v1/images/edits');
      expect(init.body).toBeInstanceOf(FormData);
      // 手写 Content-Type 会漏掉 multipart 的 boundary，服务端直接解析失败
      expect(init.headers['Content-Type']).toBeUndefined();
      const form = init.body as FormData;
      expect(form.get('prompt')).toBe('在厨房');
      expect(form.get('image')).toBeInstanceOf(File);
    });

    it('没传参考图 → 还是走 /images/generations', async () => {
      fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
      await generateImage('在厨房', cfg());
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/images/generations');
    });

    it('baseUrl 粘成 .../images/generations 时，锁脸也能正确换成 /images/edits', async () => {
      fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
      await generateImage('在厨房', cfg({ baseUrl: 'https://api.example.com/v1/images/generations' }), { referenceImage: TINY });
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/images/edits');
    });

    it.each([404, 405, 501])('端点不存在（HTTP %i）→ 抛 ReferenceUnsupportedError 供调用方回落', async (status) => {
      fetchMock.mockResolvedValue(jsonRes({ error: { message: 'not found' } }, false, status));
      await expect(generateImage('在厨房', cfg(), { referenceImage: TINY }))
        .rejects.toMatchObject({ name: 'ReferenceUnsupportedError' });
    });

    it('网络层直接连不上 → 也算不支持（中转站没这个路由时常见）', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(generateImage('在厨房', cfg(), { referenceImage: TINY }))
        .rejects.toMatchObject({ name: 'ReferenceUnsupportedError' });
    });

    it('端点在但业务报错（余额不足）→ 普通错误，不能误判成「不支持」', async () => {
      fetchMock.mockResolvedValue(jsonRes({ error: { message: 'insufficient balance' } }, false, 402));
      const err = await generateImage('在厨房', cfg(), { referenceImage: TINY }).catch(e => e);
      expect(err.name).not.toBe('ReferenceUnsupportedError');
      expect(err.message).toMatch(/402/);
    });

    it('gpt-image 走锁脸时同样不发 response_format', async () => {
      fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
      await generateImage('在厨房', cfg({ model: 'gpt-image-2' }), { referenceImage: TINY });
      expect((fetchMock.mock.calls[0][1].body as FormData).get('response_format')).toBeNull();
    });

    it('probeReferenceSupport：端点不存在 → unsupported', async () => {
      fetchMock.mockResolvedValue(jsonRes({}, false, 404));
      await expect(probeReferenceSupport(cfg())).resolves.toMatchObject({ status: 'unsupported' });
    });

    it('probeReferenceSupport：出图成功 → ok', async () => {
      fetchMock.mockResolvedValue(jsonRes({ data: [{ b64_json: PNG_B64 }] }));
      await expect(probeReferenceSupport(cfg())).resolves.toMatchObject({ status: 'ok' });
    });

    it('probeReferenceSupport：额度不足这类 → error（不能说成不支持，否则用户白白放弃）', async () => {
      fetchMock.mockResolvedValue(jsonRes({ error: { message: 'no balance' } }, false, 402));
      await expect(probeReferenceSupport(cfg())).resolves.toMatchObject({ status: 'error' });
    });
  });

  describe('dataUrlToFile', () => {
    it('还原出的 File 带正确 MIME 和字节数', () => {
      const f = dataUrlToFile('data:image/png;base64,' + PNG_B64, 'face-ref');
      expect(f.type).toBe('image/png');
      expect(f.name).toBe('face-ref.png');
      expect(f.size).toBeGreaterThan(0);
    });

    it('jpeg 的扩展名跟着 MIME 走', () => {
      expect(dataUrlToFile('data:image/jpeg;base64,/9j/4AAQ', 'x').name).toBe('x.jpg');
    });

    it('不是 data URL → 明确报错，不静默产出空文件', () => {
      expect(() => dataUrlToFile('https://example.com/a.png')).toThrow(/data URL/);
    });
  });

  it('返回「未知参数」类报错 → 错误信息里带上「去哪儿改」', async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: { message: "Unknown parameter: 'response_format'." } }, false, 400));
    await expect(generateImage('一只猫', cfg())).rejects.toThrow(/高级选项/);
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

describe('splitResponse: [[SEND_SELFIE]]', () => {
  it('拆出带 selfie 标记的 image part', () => {
    expect(ChatParser.splitResponse('刚拍的\n[[SEND_SELFIE: 窝在沙发上比耶]]')).toEqual([
      { type: 'text', content: '刚拍的' },
      { type: 'image', content: '窝在沙发上比耶', selfie: true },
    ]);
  });

  it('普通生图不带 selfie 标记（否则角色拍个晚饭也会被塞进一张脸）', () => {
    const parts = ChatParser.splitResponse('[[SEND_IMAGE: 今天的晚饭]]');
    expect(parts).toEqual([{ type: 'image', content: '今天的晚饭' }]);
    expect(parts[0].selfie).toBeUndefined();
  });

  it('自拍描述为空也保留（外貌由代码拼，场景空着能出纯人像）', () => {
    expect(ChatParser.splitResponse('[[SEND_SELFIE: ]]')).toEqual([
      { type: 'image', content: '', selfie: true },
    ]);
  });

  it('三种标签混排时顺序不乱', () => {
    expect(ChatParser.splitResponse('看[[SEND_SELFIE: 在厨房]]还有这个[[SEND_IMAGE: 晚饭]]好吃吧[[SEND_EMOJI: 得意]]')).toEqual([
      { type: 'text', content: '看' },
      { type: 'image', content: '在厨房', selfie: true },
      { type: 'text', content: '还有这个' },
      { type: 'image', content: '晚饭' },
      { type: 'text', content: '好吃吧' },
      { type: 'emoji', content: '得意' },
    ]);
  });
});
