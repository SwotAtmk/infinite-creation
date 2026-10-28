// 与主应用同一套 API 契约；studio 通过 Vite 代理把这些请求转发到后端。
const BASE = '';

function headers(extra) {
  return extra || {};
}

async function req(method, url, body) {
  const opts = { method, headers: headers({}) };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || res.status + ' ' + res.statusText);
  }
  return data;
}

export const api = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b),
  put: (u, b) => req('PUT', u, b),
  patch: (u, b) => req('PATCH', u, b),
  del: (u, b) => req('DELETE', u, b),
};

// 二进制上传：素材替换 / 技能包 zip。保持与主界面相同的请求头约定。
export async function uploadBinary(url, file, contentType) {
  const buf = await file.arrayBuffer();
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: headers({
      'Content-Type': contentType,
      'X-Filename': encodeURIComponent(file.name),
    }),
    body: buf,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

export async function uploadForm(url, formData) {
  const res = await fetch(BASE + url, { method: 'POST', headers: headers({}), body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}
