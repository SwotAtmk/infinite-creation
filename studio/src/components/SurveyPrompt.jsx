import { useEffect, useState } from 'react';
import { ClipboardList, ExternalLink } from 'lucide-react';
import { Modal } from './overlays.jsx';
import { Button } from './ui.jsx';
import { SURVEY_TITLE, SURVEY_URL } from '../lib/survey.js';

// 问卷提示：首次使用满 7 天后，每次服务启动自动弹出一次；
// 同一启动内关闭/刷新不再重复打扰（记录只写在 sessionStorage，不做永久屏蔽）。
const DISMISSED_KEY = 'ic.survey.dismissedLaunch';
// 首次使用满 7 天才开始触发问卷
const SURVEY_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

function readSession(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* 隐私模式等无法写入时忽略 */
  }
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

export default function SurveyPrompt({ launch }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!launch) return;
    const firstUsed = new Date(launch.firstLaunchAt).getTime();
    if (!Number.isFinite(firstUsed)) return;
    if (Date.now() - firstUsed < SURVEY_DELAY_MS) return;
    if (readSession(DISMISSED_KEY) === launch.lastLaunchAt) return;
    setOpen(true);
  }, [launch]);

  const dismiss = () => {
    if (launch?.lastLaunchAt) writeSession(DISMISSED_KEY, launch.lastLaunchAt);
    setOpen(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) dismiss();
      }}
      title="infinite-creation 使用问卷"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={dismiss}>
            稍后再填
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              window.open(SURVEY_URL, '_blank', 'noopener,noreferrer');
              dismiss();
            }}
          >
            <ExternalLink size={14} />
            去填写
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-[var(--fg-2)]">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--line)] bg-white/[0.04] text-[var(--accent)]">
            <ClipboardList size={17} />
          </span>
          <div className="min-w-0">
            <p className="m-0 font-medium text-[var(--fg)]">{SURVEY_TITLE}</p>
            <p className="m-0 mt-1 text-[12px] text-[var(--fg-3)]">
              欢迎花一两分钟填写问卷，帮助我们了解你的需求并改进体验。服务每次启动后会提示一次，关闭后本次使用不再打扰。
            </p>
          </div>
        </div>

        <ul className="m-0 list-disc rounded-xl border border-[var(--line)] bg-white/[0.025] py-2.5 pl-8 pr-3 text-[12.5px] text-[var(--fg-2)]">
          <li>你希望新增的创作能力与工作流</li>
          <li>使用中遇到的问题与不方便的地方</li>
          <li>对界面交互、生成效果的反馈建议</li>
        </ul>

        <a
          className="m-0 break-all text-[11.5px] text-[var(--fg-4)] underline decoration-[var(--line-strong)] underline-offset-2 transition-colors hover:text-[var(--accent)]"
          href={SURVEY_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          {SURVEY_URL}
        </a>

        {launch ? (
          <p className="m-0 text-[11.5px] text-[var(--fg-4)]">
            首次启动：{formatTime(launch.firstLaunchAt)} · 本次是第 {launch.launchCount} 次启动
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
