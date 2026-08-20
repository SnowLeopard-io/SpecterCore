import type { ReactNode } from 'react';

/** 判断图标是否为资源路径（如 /icons/foo.ico），而非 emoji/字符。 */
function isIconPath(icon: string): boolean {
  return /^(https?:)?\//.test(icon) || /\.(ico|png|svg|jpg|jpeg|webp|gif|bmp)$/i.test(icon);
}

interface AppIconProps {
  icon: string;
  /** 可选：资源类图标加载失败时的兜底字符（默认用原字符）。 */
  fallback?: string;
  className?: string;
  alt?: string;
}

/**
 * 渲染应用图标：资源路径（.ico/.png/...）显示为 <img>，其余（emoji）原样输出。
 * 这样既能兼容既有 emoji 图标，也能使用真实 Windows 程序图标。
 */
export function AppIcon({ icon, fallback, className, alt }: AppIconProps): ReactNode {
  if (isIconPath(icon)) {
    return (
      <img
        className={className}
        src={icon}
        alt={alt ?? ''}
        draggable={false}
        onError={(e) => {
          const el = e.currentTarget;
          const fb = fallback ?? icon;
          const span = document.createElement('span');
          span.textContent = fb;
          if (className) span.className = className;
          el.replaceWith(span);
        }}
      />
    );
  }
  return <span className={className}>{icon}</span>;
}
