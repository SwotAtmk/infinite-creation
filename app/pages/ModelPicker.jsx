'use client';
import { useState } from 'react';
import { Button, Input, Select, SelectItem, Spinner } from '@heroui/react';
import { api } from '../api-client.js';
import { selectKeys, pickKey } from './shared';

const MANUAL = '__manual__';
// 同一档 + 同一网址的清单缓存，切走再回设置页不用重新拉
const cache = new Map();

// 模型选择器：点「拉取模型」把该档网关支持的模型列出来供点选；
// 清单里没有的名字仍可手输（选「手动输入…」），已保存的值不会被清单弄丢。
export default function ModelPicker({ group, label = '模型', baseUrl, apiKey, value, onChange, placeholder, hint, controlClass = 'w-64', className = 'row' }) {
  const cacheKey = group + '|' + String(baseUrl || '');
  const [models, setModels] = useState(() => cache.get(cacheKey) || []);
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function fetchModels() {
    setBusy(true);
    setMsg('');
    try {
      const r = await api.post('/api/models', { group, baseUrl, apiKey });
      if (!r.ok) { setMsg('拉不到：' + (r.error || '未知错误')); return; }
      cache.set(cacheKey, r.models);
      setModels(r.models);
      setMsg(r.models.length ? ('拿到 ' + r.models.length + ' 个，点下拉框选') : '这家没返回任何模型');
    } catch (e) {
      setMsg('拉不到：' + e.message);
    } finally {
      setBusy(false);
    }
  }

  const options = value && !models.includes(value) ? [value, ...models] : models;

  return (
    <>
      <div className={className} style={{ gap: 8, alignItems: 'center' }}>
        <span style={{ flex: 'none' }}>{label}</span>
        {manual ? (
          <Input
            size="sm"
            className={controlClass}
            placeholder={placeholder}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <Select
            size="sm"
            className={controlClass}
            aria-label={label}
            placeholder={placeholder}
            selectedKeys={selectKeys(value)}
            onSelectionChange={(k) => {
              const v = pickKey(k);
              // Esc / 点外面关掉下拉时 HeroUI 也回传空值，照写会把已存的模型名清掉
              if (!v) return;
              if (v === MANUAL) { setManual(true); return; }
              setManual(false);
              onChange(v);
            }}
          >
            {options.map((m) => (
              <SelectItem key={m} textValue={m}>{m}{m === value && !models.includes(m) ? '（当前）' : ''}</SelectItem>
            ))}
            <SelectItem key={MANUAL}>手动输入…</SelectItem>
          </Select>
        )}
        <Button size="sm" variant="flat" onPress={fetchModels} isDisabled={busy}>{busy ? '拉取中' : '拉取模型'}</Button>
        {busy && <Spinner size="sm" />}
        {manual && <Button size="sm" variant="light" onPress={() => setManual(false)}>从清单选</Button>}
        {hint && <span className="muted">{hint}</span>}
      </div>
      {msg && <p className="muted" style={{ marginTop: 4 }}>{msg}</p>}
    </>
  );
}
