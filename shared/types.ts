export type Role = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
}

export interface Device {
  id: string;
  /** User-visible device alias; falls back to username@host:port when absent. */
  name?: string;
  host: string;
  port?: number;
  username: string;
  status: 'connected' | 'disconnected';
  lastCheckedAt: string;
  /** Set when the user intentionally disconnects this device session. */
  manualDisconnectedAt?: string;
  /** Normalized RDK platform id from board detect, e.g. rdk-x5 */
  boardPlatform?: string | null;
  boardModel?: string;
  boardOsVersion?: string;
  boardDetectedAt?: string;
  /**
   * Diagnostic signal source that produced `boardPlatform` via the family detector
   * (`server/managers/device-family-detector.ts`). Useful when users report
   * "板子没识别出来", so operators can see which probe actually fired.
   */
  boardFamilyDetectedBy?:
    | 'uname'
    | 'os-release'
    | 'device-tree'
    | 'tegra-release'
    | 'cpuinfo'
    | 'timeout';
  /** Suggested web_fetch / search entry points for this board */
  researchSeeds?: string[];
  /** 启用 FRP 前备份的局域网 SSH 地址（切回局域网时使用） */
  lanSshHost?: string;
  lanSshPort?: number;
  /** frps 上映射的 SSH 远程端口 */
  frpRemotePort?: number;
  /** direct=直连当前 host；tunnel=经 frp 公网映射 */
  sshReachability?: 'direct' | 'tunnel';
  /** 设备连接路径：direct 为服务端直连 SSH；bridge 为用户本机 Bridge 代连本地板卡。 */
  connectionMode?: 'direct' | 'bridge';
  /** Local Bridge 会话 id（connectionMode=bridge）。 */
  bridgeId?: string;
  /** Bridge 上报的本地设备 id（connectionMode=bridge）。 */
  bridgeDeviceId?: string;
  /** Bridge 发现该设备的本地传输方式。 */
  bridgeTransport?: 'ssh' | 'usb-ethernet' | 'serial';
}

export interface DevicePayload {
  /** Optional existing device id; when present, connect updates that record. */
  deviceId?: string;
  host: string;
  port?: number;
  username: string;
  password: string;
  /** 用户确认板卡重刷/更换后，仅本次验证允许更新已记录的 SSH 主机指纹。 */
  acceptHostKeyChange?: boolean;
  /** `/api/devices/verify` 返回的短期一次性票据；有效时保存设备无需立即重复 SSH 握手。 */
  verificationToken?: string;
  /** Optional user-visible alias for this device. */
  name?: string;
}

export interface OpenClawPayload {
  installCommand: string;
  configureCommand: string;
}

/**
 * Studio 界面已拉取的 OpenClaw / 通道状态，供 Agent 复用，减少重复 SSH health 与误判。
 * 由前端写入 sessionStorage，随 Studio 的官方 `session.prompt` admission 一并提交。
 */
export interface StudioUiHints {
  capturedAt: number;
  /** 最近一次写入来源（调试） */
  source?: string;
  /** /api/devices/:id/openclaw/health 的快照 */
  openclaw?: {
    installed?: boolean;
    gatewayRunning?: boolean;
    aiReady?: boolean;
    version?: string;
  };
  /** /api/devices/:id/openclaw/status（OpenClaw 页顶栏） */
  gateway?: {
    running?: boolean;
    version?: string;
    installed?: boolean;
  };
  /** 板端网关侧飞书插件是否连上（与 Studio→飞书机器人通道不是同一概念，勿混为一谈） */
  feishuConnected?: boolean;
  /**
   * 侧栏 `/devices/:id/ping` 最近一次非 transient 结果（按 deviceId 存在 sessionStorage）。
   * 用于服务端在磁盘列表仍为「已连接」时与真实 SSH 对齐，避免对话仍走 device 队列与板端快照。
   */
  lastDeviceSshPing?: {
    ok: boolean;
    at: number;
  };
  /** 设备板型与历史技能包同步提示（供 Agent 选择板端通道/backplane 能力） */
  board?: {
    platform?: string | null;
    model?: string | null;
    skillBundleSyncedAt?: number;
  };
  /**
   * 当前客户端主导航与嵌入页浮窗状态（前端随轮次写入，与 OpenClaw 快照独立）。
   */
  ui?: {
    activeTab?: string;
    ideEmbedFloating?: boolean;
    vncEmbedFloating?: boolean;
    ideShowIframe?: boolean;
    vncShowIframe?: boolean;
  };
}
