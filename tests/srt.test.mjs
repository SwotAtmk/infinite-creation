import test from 'node:test';
import assert from 'node:assert';
import { srtTime, buildSrt, segmentsToSrt, pickProjectFields, resolveHardwareConfig, resolveSubtitleConfig, runtimeAssetName, normalizeApiBase } from '../lib/core/index.js';

test('srtTime: 时间戳格式与进位', () => {
  assert.equal(srtTime(0), '00:00:00,000');
  assert.equal(srtTime(5), '00:00:05,000');
  assert.equal(srtTime(65.5), '00:01:05,500');
  assert.equal(srtTime(3661.234), '01:01:01,234');
  // 非法/负数按 0 处理，避免出现负时间戳
  assert.equal(srtTime(-3), '00:00:00,000');
  assert.equal(srtTime('x'), '00:00:00,000');
});

test('buildSrt: 逐镜累计时间轴，跳过无文本镜头但照常推进（字幕说完即消失）', () => {
  const srt = buildSrt([
    { duration: 5, dialogue: '林默：你好' },
    { duration: 3, dialogue: '', narration: '' },
    { duration: 4, narration: '夜色渐深' },
  ]);
  assert.equal(
    srt,
    '1\n00:00:00,000 --> 00:00:00,800\n你好\n\n'
    + '2\n00:00:08,000 --> 00:00:08,800\n夜色渐深\n',
  );
});

test('buildSrt: 台词去掉说话人前缀，按语速估算显示时长且每句一条单行字幕', () => {
  const srt = buildSrt([{ duration: 5, dialogue: '林默：走吧\n苏晚：嗯', narration: '风吹过街口' }]);
  // 每句 2 / 1 / 5 字：0.8s（最短）/ 0.8s（最短）/ 1.0s，总长 2.6s < 5s
  assert.equal(
    srt,
    '1\n00:00:00,000 --> 00:00:00,800\n走吧\n\n'
    + '2\n00:00:00,800 --> 00:00:01,600\n嗯\n\n'
    + '3\n00:00:01,600 --> 00:00:02,600\n风吹过街口\n',
  );
  assert.ok(!srt.includes('林默') && !srt.includes('苏晚'));
  // 最后一个 cue 在分镜结束前就收尾（没人说话的尾段不再挂字幕）
  assert.ok(!srt.includes('00:00:05,000'));
  // 每个 cue 只有「序号 / 时间戳 / 一行文本」三行
  const blocks = srt.trim().split('\n\n');
  assert.equal(blocks.length, 3);
  for (const b of blocks) assert.equal(b.split('\n').length, 3);
});

test('buildSrt: 台词超出分镜时长时按比例压缩，不越到下一镜', () => {
  const srt = buildSrt([
    { duration: 1, dialogue: '林默：这是一句很长的台词用来验证压缩逻辑' },
    { duration: 2, dialogue: '苏晚：下一镜' },
  ]);
  const blocks = srt.trim().split('\n\n');
  // 第一镜只有 1 秒：字幕必须在 1 秒内结束
  assert.ok(blocks[0].includes('00:00:00,000 --> 00:00:01,000'));
  // 第二镜从 1 秒开始，不因上一镜超长而顺延
  assert.ok(blocks[1].includes('00:00:01,000 --> '));
});

test('buildSrt: 全无文本时返回空串', () => {
  assert.equal(buildSrt([]), '');
  assert.equal(buildSrt([{ duration: 5, dialogue: '', narration: '  ' }]), '');
});

test('pickProjectFields: 接受 enable_subtitles 布尔开关', () => {
  assert.deepEqual(pickProjectFields({ enable_subtitles: false }).patch, { enable_subtitles: false });
  assert.deepEqual(pickProjectFields({ enable_subtitles: 'false' }).patch, { enable_subtitles: false });
  assert.deepEqual(pickProjectFields({ enable_subtitles: true }).patch, { enable_subtitles: true });
});

test('segmentsToSrt: whisper 分段转 SRT，过滤空文本 / 非法时间', () => {
  const srt = segmentsToSrt([
    { start: 0, end: 1.5, text: ' 你好 ' },
    { start: 1.5, end: 1.5, text: '零时长' },
    { start: 2, end: 3, text: '   ' },
    { start: 3, end: 4.25, text: '世界' },
  ]);
  assert.equal(
    srt,
    '1\n00:00:00,000 --> 00:00:01,500\n你好\n\n'
    + '2\n00:00:03,000 --> 00:00:04,250\n世界\n',
  );
  assert.equal(segmentsToSrt([]), '');
  assert.equal(segmentsToSrt(null), '');
});

test('字幕配置：默认经典模式 + 极速版 large-v3-turbo，非法值回退默认', () => {
  const cfg = resolveHardwareConfig({});
  assert.equal(cfg.subtitle.mode, 'script');
  assert.equal(cfg.subtitle.model, 'large-v3-turbo');
  assert.equal(cfg.subtitle.language, 'auto');
  assert.equal(cfg.subtitle.autoSetup, true);

  assert.equal(resolveSubtitleConfig(cfg).model, 'large-v3-turbo');
  assert.equal(resolveSubtitleConfig(cfg).mode, 'script');
  const bad = resolveSubtitleConfig({ subtitle: { mode: 'xxx', model: 'yyy', language: 'klingon' } });
  assert.equal(bad.mode, 'script');
  assert.equal(bad.model, 'large-v3-turbo');
  assert.equal(bad.language, 'auto');
  // 语音识别 / 外部服务 / 专业版 / 关闭自动安装要能透传
  assert.equal(resolveSubtitleConfig({ subtitle: { mode: 'whisper' } }).mode, 'whisper');
  assert.equal(resolveSubtitleConfig({ subtitle: { mode: 'api' } }).mode, 'api');
  assert.equal(resolveSubtitleConfig({ subtitle: { model: 'large-v3' } }).model, 'large-v3');
  assert.equal(resolveSubtitleConfig({ subtitle: { autoSetup: false } }).autoSetup, false);
});

test('外部字幕服务地址：补协议、去尾斜杠、空值走默认', () => {
  assert.equal(normalizeApiBase('localhost:8000'), 'http://localhost:8000');
  assert.equal(normalizeApiBase('http://127.0.0.1:8000///'), 'http://127.0.0.1:8000');
  assert.equal(normalizeApiBase(' https://a2s.example.com '), 'https://a2s.example.com');
  assert.equal(normalizeApiBase(''), '');
  // 未配置时用默认本地地址
  assert.equal(resolveSubtitleConfig({ subtitle: { mode: 'api' } }).apiBaseUrl, 'http://127.0.0.1:8000');
});

test('便携 Python：当前平台资产名符合 install_only 约定（不支持的平台返回空串）', () => {
  const asset = runtimeAssetName();
  if (!asset) return; // 未适配的平台：由调用方提示手动安装
  assert.match(asset, /^cpython-3\.\d+\.\d+\+\d+-.+-install_only\.tar\.gz$/);
});
