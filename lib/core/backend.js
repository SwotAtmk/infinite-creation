import { generate, downloadOutput, uploadToInput, interrupt, freeComfy, checkComfyUI } from './comfyui.js';
import * as rh from './runninghub.js';
import { isCloudApi, cloudDownload, cloudLocalRef, cloudCheck, cloudCancel } from './cloud-api.js';

// —— 渲染后端分派层 ——
// 原生 ComfyUI 逻辑（comfyui.js）保持不变；这里按 cfg.comfyui.provider 分派：
//   native     → 走 comfyui.js（传 cfg.comfyui.baseUrl）
//   runninghub → 走 runninghub.js 标准 OpenAPI（用 cfg.comfyui.apiKey / tier）
//   api        → 走 cloud-api.js 云端商业 API（OpenAI 兼容生图/视频 + 小米 MiMo 配音）
const isRunningHub = (cfg) => cfg?.comfyui?.provider === 'runninghub';

// 提交 + 等待完成，返回 { prompt_id, outputs, entry }（RunningHub 下 prompt_id = taskId）
export function generateTask(cfg, workflow, opts) {
  if (isCloudApi(cfg)) throw new Error('api 模式应走 cloudGenerate，不接受 ComfyUI 工作流提交');
  if (isRunningHub(cfg)) return rh.runninghubGenerate(cfg, workflow, opts);
  return generate(cfg.comfyui.baseUrl, workflow, opts);
}

// 上传参考文件，返回「上传后的文件名」：native 返回传入 filename；runninghub 返回平台 fileName
// api 不上传（云端 API base64 直传）：返回本地绝对路径，供适配器读文件
export async function uploadTaskInput(cfg, localPath, filename) {
  if (isCloudApi(cfg)) return cloudLocalRef(localPath);
  if (isRunningHub(cfg)) return rh.runninghubUpload(cfg, localPath);
  await uploadToInput(cfg.comfyui.baseUrl, localPath, filename);
  return filename;
}

// 下载产物，返回 Buffer
export async function downloadTaskOutput(cfg, out) {
  if (isCloudApi(cfg)) return cloudDownload(out.fileUrl);
  if (isRunningHub(cfg)) return rh.runninghubDownload(out.fileUrl);
  return downloadOutput(cfg.comfyui.baseUrl, out);
}

// 打断/取消任务：runninghub/api 需 taskId（无 taskId 时 no-op，由 generateTask 内部 isAborted 兜底）
export function interruptTask(cfg, taskId) {
  if (isCloudApi(cfg)) return taskId ? cloudCancel(cfg, taskId) : Promise.resolve();
  if (isRunningHub(cfg)) return taskId ? rh.runninghubCancel(cfg, taskId) : Promise.resolve();
  return interrupt(cfg.comfyui.baseUrl);
}

// 释放显存：runninghub/api 云端无需（无 /free 端点）
export function freeBackend(cfg) {
  if (isCloudApi(cfg)) return Promise.resolve();
  if (isRunningHub(cfg)) return Promise.resolve();
  return freeComfy(cfg.comfyui.baseUrl);
}

// 就绪检查
export function checkBackend(cfg) {
  if (isCloudApi(cfg)) return cloudCheck(cfg);
  if (isRunningHub(cfg)) return rh.runninghubCheck(cfg);
  return checkComfyUI(cfg.comfyui.baseUrl);
}
