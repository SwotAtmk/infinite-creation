/**
 * AI漫剧策划包导出脚本
 * 将项目所有策划文档汇总生成 README 和文件清单
 * 
 * 使用方式：node export.js <项目目录路径>
 */

const fs = require('fs');
const path = require('path');

const projectDir = process.argv[2];

if (!projectDir) {
  console.error('用法：node export.js <项目目录路径>');
  process.exit(1);
}

const stateFile = path.join(projectDir, 'state.json');
if (!fs.existsSync(stateFile)) {
  console.error('找不到 state.json，请确认项目目录正确');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

const files = [
  { file: 'brief.md', label: '📋 需求简报' },
  { file: 'market-report.md', label: '📊 市场分析报告' },
  { file: 'world-bible.md', label: '🌍 世界观圣经' },
  { file: 'characters.md', label: '👥 人物设定表' },
  { file: 'outline.md', label: '📖 分集大纲' },
];

let readme = `# ${state.project} - 策划文档包\n\n`;
readme += `> 生成时间：${new Date().toLocaleString('zh-CN')}\n`;
readme += `> 总集数：${state.total_episodes} 集\n\n`;
readme += `## 📁 文档清单\n\n`;

files.forEach(({ file, label }) => {
  const fullPath = path.join(projectDir, file);
  const exists = fs.existsSync(fullPath);
  readme += `- ${exists ? '✅' : '⬜'} ${label}：\`${file}\`\n`;
});

readme += `\n### 剧本\n`;
for (let i = 1; i <= state.total_episodes; i++) {
  const epFile = `scripts/ep${String(i).padStart(2, '0')}.md`;
  const exists = fs.existsSync(path.join(projectDir, epFile));
  readme += `- ${exists ? '✅' : '⬜'} 第${i}集剧本：\`${epFile}\`\n`;
}

readme += `\n### 分镜脚本\n`;
for (let i = 1; i <= state.total_episodes; i++) {
  const boardFile = `storyboards/ep${String(i).padStart(2, '0')}-board.md`;
  const exists = fs.existsSync(path.join(projectDir, boardFile));
  readme += `- ${exists ? '✅' : '⬜'} 第${i}集分镜：\`${boardFile}\`\n`;
}

const readmePath = path.join(projectDir, 'README.md');
fs.writeFileSync(readmePath, readme, 'utf8');

console.log(`✅ 策划包 README 已生成：${readmePath}`);
console.log(`\n项目：${state.project}`);
console.log(`当前进度：STATE ${state.current_state}`);
console.log(`已完成阶段：${state.completed_states.join(', ') || '无'}`);
