/**
 * 文本解码（Windows 兼容层）。
 *
 * 中文 Windows 记事本默认以 ANSI（GBK/GB18030）保存 .txt，
 * 若一律按 UTF-8 解码会得到 U+FFFD 乱码方块。策略：
 *  1. 先按 UTF-8 严格解码（有效即返回）；
 *  2. 失败回退 GBK；
 *  3. 仍失败则用宽松 UTF-8（保留原始行为）。
 * 保存侧统一 UTF-8（现代标准），仅读取侧做兼容。
 * 解码器懒加载：GBK 在极简 ICU 环境下可能不可用，避免模块加载即抛错。
 */

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
const UTF8_LENIENT = new TextDecoder('utf-8');

let gbk: TextDecoder | null | undefined;

function getGbk(): TextDecoder | null {
  if (gbk === undefined) {
    try {
      gbk = new TextDecoder('gbk');
    } catch {
      gbk = null;
    }
  }
  return gbk;
}

export function decodeText(data: Uint8Array): string {
  try {
    return UTF8_STRICT.decode(data);
  } catch {
    const gbkDecoder = getGbk();
    if (gbkDecoder) {
      try {
        return gbkDecoder.decode(data);
      } catch {
        // fall through to lenient UTF-8
      }
    }
    return UTF8_LENIENT.decode(data);
  }
}
