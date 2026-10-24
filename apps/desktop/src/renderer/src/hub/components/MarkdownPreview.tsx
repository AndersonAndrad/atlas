import type { NoteLinkStatus } from '@atlas/contracts';
import { NOTE_LINK_SCHEME } from '@atlas/contracts';
import { ImageOff, Unlink } from 'lucide-react';
import type { ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isExternalUrl, safeNoteUrl } from '../markdown';

interface MarkdownPreviewProps {
  markdown: string;
  /** Status of the note's `atlas:` links; links without a status are shown as checking. */
  links: ReadonlyMap<string, NoteLinkStatus>;
  onOpenLink: (href: string) => void;
  onOpenExternal: (url: string) => void;
}

/**
 * Renders a note's Markdown (SDD-010 FR-1003). Untrusted content: raw HTML is skipped,
 * URLs pass `safeNoteUrl`, images are never loaded and links never navigate the window.
 */
export function MarkdownPreview({
  markdown,
  links,
  onOpenLink,
  onOpenExternal,
}: MarkdownPreviewProps) {
  const components: Components = {
    a: ({ href, children }) => (
      <NoteAnchor
        href={href ?? ''}
        status={href ? links.get(href) : undefined}
        onOpenLink={onOpenLink}
        onOpenExternal={onOpenExternal}
      >
        {children}
      </NoteAnchor>
    ),
    // Remote images could track reading; local ones have no meaning in the app.
    img: ({ alt }) => (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
        <ImageOff className="size-3" aria-hidden />
        {alt ? `Image: ${alt}` : 'Image'}
      </span>
    ),
  };
  return (
    <div className="note-markdown" data-testid="note-preview">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeNoteUrl}
        components={components}
      >
        {markdown}
      </Markdown>
    </div>
  );
}

interface NoteAnchorProps {
  href: string;
  status: NoteLinkStatus | undefined;
  onOpenLink: (href: string) => void;
  onOpenExternal: (url: string) => void;
  children: ReactNode;
}

function NoteAnchor({ href, status, onOpenLink, onOpenExternal, children }: NoteAnchorProps) {
  const linkClass = 'text-primary underline underline-offset-4 hover:opacity-80';
  if (href.startsWith(NOTE_LINK_SCHEME)) {
    if (status !== undefined && !status.valid) {
      return (
        <span
          className="text-muted-foreground inline-flex items-center gap-1 line-through"
          title="Broken link: the target does not exist or is not available here."
          data-testid="note-broken-link"
        >
          <Unlink className="size-3" aria-hidden />
          {children}
        </span>
      );
    }
    return (
      <a
        href={href}
        className={linkClass}
        title={status?.label ?? undefined}
        onClick={(event) => {
          event.preventDefault();
          onOpenLink(href);
        }}
      >
        {children}
      </a>
    );
  }
  if (isExternalUrl(href)) {
    return (
      <a
        href={href}
        className={linkClass}
        title={href}
        rel="noreferrer noopener"
        onClick={(event) => {
          event.preventDefault();
          onOpenExternal(href);
        }}
      >
        {children}
      </a>
    );
  }
  // Dropped by `safeNoteUrl` (or an in-page anchor): plain text, never a navigation.
  return <span className="underline decoration-dotted">{children}</span>;
}
