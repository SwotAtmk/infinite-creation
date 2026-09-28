import { runOpenClaudeAgent } from '../lib/agent/openclaude-agent.js';

const PID = process.env.PID || 'd51107dc-0bac-4315-8ebb-405679a8b3a9';
const t0 = Date.now();

runOpenClaudeAgent({
  projectId: PID,
  chapter: process.env.CHAPTER || '',
  jobId: 'e2e-' + Date.now(),
  onProgress: (p) => {
    const ms = String(Date.now() - t0).padStart(6);
    console.log('[' + ms + 'ms]', (p.phase || '').padEnd(10), String(p.detail || '').slice(0, 220));
  },
  isAborted: () => false,
}).then((summary) => {
  console.log('=== SUCCESS in ' + (Date.now() - t0) + 'ms ===');
  console.log(String(summary || '').slice(0, 800));
  process.exit(0);
}).catch((e) => {
  console.log('=== FAILED in ' + (Date.now() - t0) + 'ms ===');
  console.log(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
