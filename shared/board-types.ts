/**
 * Board platform identifiers.
 *
 * `RdkPlatform`：D-Robotics 内置板型（可选适配层；Agent 核心应使用 `DevicePlatform`）。
 * `DevicePlatform`：可扩展联合，任意板卡家族（Jetson、树莓派、RK 等）——**新代码优先**。
 */
export type RdkPlatform = 'rdk-x3' | 'rdk-x5' | 'rdk-ultra' | 'rdk-s100' | 'rdk-s100p' | 'rdk-s600';

/** 远程设备逻辑平台：厂商无关；具体探测由 board adapter 填充标签 */
export type DevicePlatform = RdkPlatform | 'linux-generic' | (string & {});

export const ALL_RDK_PLATFORMS: RdkPlatform[] = ['rdk-x3', 'rdk-x5', 'rdk-ultra', 'rdk-s100', 'rdk-s100p', 'rdk-s600'];
