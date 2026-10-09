'use client';
import { useEffect, useState, useCallback } from 'react';
import { Card, CardBody, Chip } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';

// ============ 工作流（仅展示系统已注册） ============
export default function WorkflowsTab() {
  const toast = useToast();
  const [workflows, setWorkflows] = useState([]);
  const load = useCallback(() => api.get('/api/workflows').then(setWorkflows).catch((e) => toast.error(e.message)), []);
  useEffect(() => { load(); }, [load]);

  return (
    <Card shadow="none" className="border border-default-200">
      <CardBody className="gap-2">
        <h2 className="text-lg font-semibold m-0">已注册工作流</h2>
        {workflows.map((w) => (
          <div key={w.id} className="row justify-between py-1.5 border-b border-default-100">
            <div className="flex items-center gap-2">
              <b>{w.name}</b>
              <Chip size="sm" variant="flat">{w.kind}</Chip>
              <span className="muted">{w.sourceFile}</span>
            </div>
          </div>
        ))}
        {!workflows.length && <p className="muted">暂无已注册工作流</p>}
      </CardBody>
    </Card>
  );
}