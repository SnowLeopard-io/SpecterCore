import type { WinError } from './bridge/fs';
import type { UsbDeviceInfo } from './host';
import type { ProcessInfo, ThreadInfo } from './core/process';
import type { WindowHandle } from './ui';

/**
 * 全系统事件表：各层之间唯一的通信通道。
 * 新事件在此注册即可被任意层订阅，无需层间直接引用。
 */
export type KernelEvents = {
  /** 内核生命周期 */
  'kernel:init': void;
  'kernel:start': void;
  'kernel:stop': void;

  /** L1 宿主层 */
  'host:fs:ready': { storeName: string; capacity: number };
  'host:fs:capacity': { usedBytes: number; capacity: number };
  'host:usb:connected': UsbDeviceInfo;
  'host:usb:disconnected': UsbDeviceInfo;
  'host:usb:authorization-requested': { target: string };

  /** L2 桥接层 */
  'bridge:fs:error': { path: string; error: WinError; operation: string };
  'bridge:fs:handle-leak': { leaked: number };

  /** L3 兼容核心 */
  'core:process:created': ProcessInfo;
  'core:process:exited': { pid: number; exitCode: number };
  'core:thread:created': ThreadInfo;
  'core:api:call': { module: string; proc: string; args: readonly number[] };
  'core:api:not-implemented': { module: string; proc: string };
  /** 客户机写入控制台的字节（stdout/stderr，L6 桌面可订阅渲染） */
  'core:console:write': { pid: number; handle: number; bytes: Uint8Array };

  /** L4 驱动层 */
  'drivers:usb:attached': { driverId: string; device: UsbDeviceInfo };
  'drivers:usb:detached': { driverId: string; device: UsbDeviceInfo };

  /** L6 界面层 */
  'ui:window:created': WindowHandle;
  'ui:window:closed': { id: string };
  'ui:window:focused': { id: string };
};

/** 无载荷事件的便捷别名 */
export type VoidEvent = undefined | void;
