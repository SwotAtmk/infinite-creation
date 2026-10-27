export type StudioViewType = 'list' | 'project' | 'settings';
export type StudioTab = 'chapters' | 'assets' | 'shots' | 'music' | 'exports' | 'logs';

export interface StudioView {
  view: StudioViewType;
  id: string | null;
  tab: StudioTab | string | null;
}

export interface StudioOptions {
  /** 挂载点：CSS 选择器或元素 */
  target?: string | Element;
  /** 也可直接传 mount 元素 */
  mount?: Element;
  /** Studio 地址，默认从 SDK 的 script src 推导 */
  baseUrl?: string;
  /** 宿主会话 token，会通过 URL + postMessage 传给 Studio */
  session?: string;
  /** 初始视图 */
  view?: StudioViewType;
  id?: string;
  tab?: StudioTab | string;
  embed?: boolean;
  title?: string;
  width?: string;
  height?: string;
  onReady?: (api: StudioApi, payload: { type: 'studio:ready'; version: number; hasSession?: boolean }) => void;
  onView?: (view: StudioView, api: StudioApi) => void;
  onMessage?: (message: unknown, api: StudioApi) => void;
}

export interface StudioApi {
  readonly iframe: HTMLIFrameElement;
  readonly version: number;
  isReady(): boolean;
  getView(): StudioView;
  navigate(view: StudioViewType, opts?: { id?: string; tab?: StudioTab | string }): StudioApi;
  setSession(token: string): StudioApi;
  reload(): StudioApi;
  destroy(): void;
}

export declare const version: number;
export declare function create(options?: StudioOptions): StudioApi;

declare const ICStudio: { version: number; create: typeof create };
export default ICStudio;
