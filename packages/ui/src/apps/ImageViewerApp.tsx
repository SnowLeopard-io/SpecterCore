import { useEffect, useRef, useState } from 'react';
import { useUi } from '../context';

interface ImageViewerProps {
  /** 启动即打开的图片（store 路径），来自 open 动词。 */
  initialFile?: string;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico']);

function parentOf(storePath: string): string {
  const segs = storePath.split('/').filter(Boolean);
  segs.pop();
  return segs.join('/');
}

function basenameOf(storePath: string): string {
  const segs = storePath.split('/').filter(Boolean);
  return segs[segs.length - 1] ?? storePath;
}

/**
 * Image Viewer (Windows 11 Photos style): opens images from the virtual disk,
 * with previous/next navigation across sibling images in the same folder.
 */
export function ImageViewerApp({ initialFile }: ImageViewerProps) {
  const { controller } = useUi();
  const fs = controller.getFileSystem();

  const [path, setPath] = useState<string | null>(initialFile ?? null);
  const [url, setUrl] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [siblings, setSiblings] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const urlRef = useRef<string | null>(null);

  // 卸载时释放 object URL。
  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  // 加载当前路径的图片，并计算同目录图片列表用于 上一张/下一张。
  useEffect(() => {
    if (!path || !fs) return;
    let cancelled = false;
    void (async () => {
      try {
        const file = await fs.openFile(path, 'read');
        let data: Uint8Array;
        try {
          const size = await file.size();
          data = await file.read(0, size);
        } finally {
          await file.close();
        }
        if (cancelled) return;
        const blob = new Blob([data as BlobPart]);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = URL.createObjectURL(blob);
        setUrl(urlRef.current);
        setName(basenameOf(path));
        setError(null);

        const parent = parentOf(path);
        const entries = await fs.listDirectory(parent);
        if (cancelled) return;
        const images = entries
          .filter((e) => e.kind === 'file' && IMAGE_EXTENSIONS.has(e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase()))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
        setSiblings(images);
        setIndex(images.indexOf(basenameOf(path)));
      } catch (err: unknown) {
        if (!cancelled) setError(`Cannot open image: ${String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, fs]);

  const step = (dir: -1 | 1): void => {
    if (!path) return;
    const next = siblings[index + dir];
    if (!next) return;
    const parent = parentOf(path);
    setPath(parent === '' ? next : `${parent}/${next}`);
  };

  return (
    <div className="bk-image-viewer">
      <div className="bk-image-toolbar">
        <button
          className="bk-image-nav"
          disabled={index <= 0}
          onClick={() => step(-1)}
          aria-label="Previous image"
        >
          ◀
        </button>
        <span className="bk-image-name">{name}</span>
        <span className="bk-image-counter">
          {index >= 0 ? `${index + 1} / ${siblings.length}` : ''}
        </span>
        <button
          className="bk-image-nav"
          disabled={index < 0 || index >= siblings.length - 1}
          onClick={() => step(1)}
          aria-label="Next image"
        >
          ▶
        </button>
      </div>
      <div className="bk-image-stage">
        {error && <div className="bk-image-error">{error}</div>}
        {!error && url && <img className="bk-image-img" src={url} alt={name} draggable={false} />}
        {!error && !url && (
          <div className="bk-image-empty">Open an image from the virtual disk</div>
        )}
      </div>
    </div>
  );
}
