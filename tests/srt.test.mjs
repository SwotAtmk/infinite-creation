import test from 'node:test';
import assert from 'node:assert';
import { srtTime, buildSrt, pickProjectFields } from '../lib/core/index.js';

test('srtTime: 时间戳格式与进位', () => {
  assert.equal(srtTime(0), '00:00:00,000');
  assert.equal(srtTime(5), '00:00:05,000');
  assert.equal(srtTime(65.5), '00:01:05,500');
  assert.equal(srtTime(3661.234), '01:01:01,234');
  // 非法/负数按 0 处理，避免出现负时间戳
  assert.equal(srtTime(-3), '00:00:00,000');
  assert.equal(srtTime('x'), '00:00:00,000');
});

test('buildSrt: 逐镜累计时间轴，跳过无文本镜头但照常推进（字幕不含角色名）', () => {
  const srt = buildSrt([
    { duration: 5, dialogue: '林默：你好' },
    { duration: 3, dialogue: '', narration: '' },
    { duration: 4, narration: '夜色渐深' },
  ]);
  assert.equal(
    srt,
    '1\n00:00:00,000 --> 00:00:05,000\n你好\n\n'
    + '2\n00:00:08,000 --> 00:00:12,000\n夜色渐深\n',
  );
});

test('buildSrt: 台词去掉说话人前缀、与旁白合并、duration 缺省回退 5 秒', () => {
  const srt = buildSrt([{ dialogue: '林默：走吧\n\n苏晚：嗯', narration: '风吹过街口' }]);
  assert.ok(srt.includes('00:00:00,000 --> 00:00:05,000'));
  assert.ok(srt.includes('走吧\n嗯\n风吹过街口\n'));
  assert.ok(!srt.includes('林默') && !srt.includes('苏晚'));
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
