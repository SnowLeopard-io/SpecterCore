/**
 * @bk/contracts - 层间接口契约（唯一事实来源）
 *
 * 本包是整个 Browser Kernel 的解耦基石：
 *  - 只包含类型定义、枚举与常量，零运行时实现；
 *  - 所有层（L1-L6）的包只能依赖本包 + 共享工具，禁止跨层直接依赖；
 *  - 各层通过 DI 令牌（tokens）注册/解析服务，通过事件总线通信。
 */

export * from './kernel';
export * from './events';
export * from './di';
export * from './tokens';
export * from './host';
export * from './bridge/fs';
export * from './bridge/graphics';
export * from './bridge/audio';
export * from './bridge/usb';
export * from './core/process';
export * from './core/api';
export * from './core/pe';
export * from './core/jit';
export * from './drivers';
export * from './package';
export * from './ui';