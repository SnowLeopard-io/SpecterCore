/**
 * Inline SVG icons used across the UI. All icons inherit `currentColor`, so
 * the consumer controls fill / stroke color via CSS. Sizes default to 16px
 * (toolbar / navpane) or 20px (file rows); pass `size` to override.
 *
 * Style: Windows 11 Fluent-style line icons. Stroke width 1.5, rounded caps
 * and joins. Solid variants (folder, Windows logo) use `fill="currentColor"`.
 */

interface IconProps {
  size?: number;
  className?: string;
  title?: string;
}

function svg(props: IconProps, body: string, viewBox = '0 0 24 24'): React.JSX.Element {
  const { size = 16, className, title } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      dangerouslySetInnerHTML={title ? { __html: `<title>${title}</title>${body}` } : { __html: body }}
    />
  );
}

// ---------- Toolbar ----------

export function BackIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<path d="M11 5 L6 10 L11 15"/><path d="M6 10 H17"/>`,
  );
}

export function UpIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<path d="M12 16 V6"/><path d="M7 11 L12 6 L17 11"/>`,
  );
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<path d="M19 12 a7 7 0 1 1 -2 -5"/><path d="M19 4 V9 H14"/>`,
  );
}

export function NewFolderIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<path d="M3 6 a1 1 0 0 1 1 -1 H9 L11 7 H19 a1 1 0 0 1 1 1 V18 a1 1 0 0 1 -1 1 H4 a1 1 0 0 1 -1 -1 Z"/><path d="M11 11 H15"/><path d="M13 9 V13"/>`,
  );
}

// ---------- Navpane (sidebar) ----------

export function DesktopIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<rect x="2" y="4" width="20" height="13" rx="1.5"/><path d="M8 21 H16"/><path d="M12 17 V21"/>`,
  );
}

export function UsersIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<circle cx="12" cy="8" r="4"/><path d="M4 21 a8 8 0 0 1 16 0"/>`,
  );
}

export function WindowsLogoIcon(props: IconProps): React.JSX.Element {
  // Solid four-tile Windows logo. Overrides the line defaults via fill.
  const { size = 16, className, title } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      dangerouslySetInnerHTML={
        title
          ? { __html: `<title>${title}</title><path d="M3 5.5 L11 4 V11 H3 Z" /><path d="M13 3.8 L21 3 V11 H13 Z" /><path d="M3 13 H11 V20.5 L3 19 Z" /><path d="M13 13 H21 V21 L13 20.2 Z" />` }
          : { __html: '<path d="M3 5.5 L11 4 V11 H3 Z" /><path d="M13 3.8 L21 3 V11 H13 Z" /><path d="M3 13 H11 V20.5 L3 19 Z" /><path d="M13 13 H21 V21 L13 20.2 Z" />' }
      }
    />
  );
}

export function HardDriveIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<rect x="3" y="6" width="18" height="12" rx="1.5"/><rect x="6" y="9" width="12" height="1.5" fill="currentColor" stroke="none"/><circle cx="17" cy="14" r="0.6" fill="currentColor" stroke="none"/>`,
  );
}

// ---------- File rows ----------

export function FolderIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<path d="M3 6 a1 1 0 0 1 1 -1 H9 L11 7 H19 a1 1 0 0 1 1 1 V18 a1 1 0 0 1 -1 1 H4 a1 1 0 0 1 -1 -1 Z"/>`,
  );
}

export function DocumentIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<path d="M6 3 H14 L19 8 V20 a1 1 0 0 1 -1 1 H6 a1 1 0 0 1 -1 -1 V4 a1 1 0 0 1 1 -1 Z"/><path d="M14 3 V8 H19"/><path d="M8 13 H16 M8 16 H16 M8 19 H13"/>`,
  );
}

export function ImageFileIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<rect x="4" y="4" width="16" height="16" rx="1.5"/><circle cx="9" cy="9.5" r="1.5"/><path d="M4 17 L8 12 L12 16 L15 13 L20 18 V19 a1 1 0 0 1 -1 1 H5 a1 1 0 0 1 -1 -1 Z"/>`,
  );
}

export function AudioFileIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<path d="M9 18 V6 L19 3 V15"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/>`,
  );
}

export function ApplicationIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8 8 H16 M8 12 H16 M8 16 H13"/>`,
  );
}

export function PackageIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<path d="M3 7 L12 3 L21 7 L12 11 Z"/><path d="M3 7 V17 L12 21"/><path d="M21 7 V17 L12 21"/><path d="M12 11 V21"/>`,
  );
}

export function GenericFileIcon(props: IconProps): React.JSX.Element {
  return DocumentIcon(props);
}

export function OpenIcon(props: IconProps): React.JSX.Element {
  return svg(props, `<path d="M14 4 H20 V20 H4 V8 H10"/><path d="M10 4 V8 H4"/>`);
}

export function DownloadIcon(props: IconProps): React.JSX.Element {
  return svg(props, `<path d="M12 4 V15"/><path d="M7 11 L12 16 L17 11"/><path d="M5 20 H19"/>`);
}

export function RunIcon(props: IconProps): React.JSX.Element {
  // Solid play triangle.
  const { size = 16, className, title } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      dangerouslySetInnerHTML={
        title
          ? { __html: `<title>${title}</title><path d="M7 5 V19 L19 12 Z" />` }
          : { __html: '<path d="M7 5 V19 L19 12 Z" />' }
      }
    />
  );
}

export function CopyIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<rect x="4" y="4" width="14" height="14" rx="1.5"/><path d="M8 8 H20 a1 1 0 0 1 1 1 V19 a1 1 0 0 1 -1 1 H10 a1 1 0 0 1 -1 -1 Z"/>`,
  );
}

export function PasteIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<rect x="5" y="5" width="14" height="15" rx="1.5"/><rect x="9" y="3" width="6" height="4" rx="0.8"/><path d="M9 13 H15 M9 16 H13"/>`,
  );
}

export function RenameIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<path d="M4 20 H8 L19 9 L15 5 L4 16 Z"/><path d="M14 6 L18 10"/>`,
  );
}

export function DeleteIcon(props: IconProps): React.JSX.Element {
  return svg(
    props,
    `<path d="M5 7 H19"/><path d="M9 7 V5 a1 1 0 0 1 1 -1 H14 a1 1 0 0 1 1 1 V7"/><path d="M6 7 L7 21 H17 L18 7"/><path d="M10 11 V17 M14 11 V17"/>`,
  );
}

export function CloseIcon(props: IconProps): React.JSX.Element {
  return svg(props, `<path d="M6 6 L18 18 M18 6 L6 18"/>`);
}

/** Pick the right file SVG based on the entry name. */
export function FileIcon(props: { entry: { kind: string; name: string }; size?: number; className?: string }): React.JSX.Element {
  const { entry, size = 20, className } = props;
  if (entry.kind === 'directory') return <FolderIcon size={size} className={className} />;
  const lower = entry.name.toLowerCase();
  if (lower.endsWith('.exe') || lower.endsWith('.dll'))
    return <ApplicationIcon size={size} className={className} />;
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif') || lower.endsWith('.bmp'))
    return <ImageFileIcon size={size} className={className} />;
  if (lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.ogg'))
    return <AudioFileIcon size={size} className={className} />;
  if (lower.endsWith('.bkapp')) return <PackageIcon size={size} className={className} />;
  return <DocumentIcon size={size} className={className} />;
}