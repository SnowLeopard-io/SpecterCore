import { toArrayBuffer } from '@specter-core/shared';

/**
 * 把虚拟盘里的字节下载到真实磁盘（浏览器下载），用于导出/检查文件内容。
 * data 需为独立 ArrayBuffer 备份，避免引用被后续修改。
 */
export function downloadBytes(filename: string, data: Uint8Array): void {
  const buffer = toArrayBuffer(data);
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
