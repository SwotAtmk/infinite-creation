'use client';
import { useEffect, useState, useCallback } from 'react';
import { api } from '../api-client.js';
import { useToast } from '../toast';

// ============ 工作流（仅展示系统已注册） ============
export default function WorkflowsTab() {
  const toast = useToast();
  const [workflows, setWorkflows] = useState([]);
  const load = useCallback(() => api.get('/api/workflows').then(setWorkflows).catch((e) => toast.error(e.message)), []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="card">
      <h2>已注册工作流</h2>
      {workflows.map((w) => (
        <div key={w.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #232936' }}>
          <div><b>{w.name}</b> <span className="tag">{w.kind}</span> <span className="muted">{w.sourceFile}</span></div>
        </div>
      ))}
      {!workflows.length && <p className="muted">暂无已注册工作流</p>}
    </div>
  );
}