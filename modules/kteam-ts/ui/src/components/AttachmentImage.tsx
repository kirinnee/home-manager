import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Download, ExternalLink, FileText, ImageOff, X } from 'lucide-react';
import { api } from '../lib/api';
import {
  attachmentTypeLabel,
  formatAttachmentSize,
  isBrowserOpenableAttachment,
  isImageMime,
  type StoredTranscriptAttachment,
  type TranscriptImage,
} from '../lib/attachments';
import { cn } from '../lib/utils';
import { useDialogFocus } from '../hooks/useDialogFocus';

interface CacheEntry {
  promise: Promise<string>;
  url?: string;
  refs: number;
  touched: number;
}

/** Session-scoped blob URL cache. Entries in use are pinned; idle entries are
 * evicted least-recently-used, and every remaining URL is revoked when the chat
 * page unmounts. */
export class AttachmentBlobCache {
  private readonly entries = new Map<string, CacheEntry>();
  private clock = 0;

  constructor(private readonly capacity = 24) {}

  acquire(key: string, load: () => Promise<Blob>): Promise<string> {
    const present = this.entries.get(key);
    if (present) {
      present.refs += 1;
      present.touched = ++this.clock;
      return present.promise;
    }

    const entry: CacheEntry = {
      refs: 1,
      touched: ++this.clock,
      promise: Promise.resolve(''),
    };
    entry.promise = load()
      .then(blob => {
        const url = URL.createObjectURL(blob);
        // A released in-flight entry may have been evicted, or the provider may
        // have been disposed, before its fetch settled. It no longer has an
        // owner that can revoke the URL, so revoke it here instead of leaking
        // it through the detached promise. The identity guard also protects a
        // newer request for the same key from the old request's settlement.
        if (this.entries.get(key) !== entry) {
          URL.revokeObjectURL(url);
          throw new Error('attachment request is no longer needed');
        }
        entry.url = url;
        return url;
      })
      .catch(error => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, entry);
    this.evict();
    return entry.promise;
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.touched = ++this.clock;
    this.evict();
  }

  dispose(): void {
    for (const entry of this.entries.values()) if (entry.url) URL.revokeObjectURL(entry.url);
    this.entries.clear();
  }

  private evict(): void {
    while (this.entries.size > this.capacity) {
      let victim: [string, CacheEntry] | undefined;
      for (const candidate of this.entries) {
        if (candidate[1].refs > 0) continue;
        if (!victim || candidate[1].touched < victim[1].touched) victim = candidate;
      }
      if (!victim) return;
      this.entries.delete(victim[0]);
      if (victim[1].url) URL.revokeObjectURL(victim[1].url);
    }
  }
}

function AttachmentDocumentCard({ attachment }: { attachment: StoredTranscriptAttachment }) {
  const sharedCache = useContext(AttachmentCacheContext);
  const localCache = useRef<AttachmentBlobCache | null>(null);
  localCache.current ??= new AttachmentBlobCache(1);
  useEffect(() => () => localCache.current?.dispose(), []);
  const cache = sharedCache ?? localCache.current;
  const host = useRef<HTMLDivElement | null>(null);
  const visible = useVisible(host, false);
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  const key = `${attachment.sessionId}/${attachment.attachmentId}`;

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setSrc('');
    setFailed(false);
    void cache
      .acquire(key, () => api.attachment(attachment.sessionId, attachment.attachmentId))
      .then(url => {
        if (active) setSrc(url);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      cache.release(key);
    };
  }, [attachment.attachmentId, attachment.sessionId, cache, key, visible]);

  const type = attachmentTypeLabel(attachment.mime);
  const metadata = [attachment.mime, formatAttachmentSize(attachment.size)].filter(Boolean).join(' · ');
  return (
    <div
      ref={host}
      className="flex min-w-0 max-w-full gap-2 rounded-control border border-border-soft bg-surface-2 p-2 text-left"
    >
      <FileText size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-meta leading-tight">
        <span className="block truncate text-fg" title={attachment.filename}>
          {attachment.filename}
        </span>
        <span className="block truncate text-faint" title={metadata}>
          {type}
          {metadata ? ` · ${metadata}` : ''}
        </span>
        {attachment.textExtraction && (
          <span className="block text-faint">
            text extracted for agent{attachment.textExtraction.truncated ? ' · truncated' : ''}
          </span>
        )}
        {failed ? (
          <span className="block text-warn">file could not be opened</span>
        ) : (
          <>
            {!src && (
              <span className="block text-muted" role="status">
                loading file…
              </span>
            )}
            <span className="mt-1 flex flex-wrap gap-1">
              {isBrowserOpenableAttachment(attachment.mime) && (
                <a
                  {...(src ? { href: src } : {})}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-disabled={!src}
                  className="inline-flex min-h-[44px] min-w-[44px] items-center gap-1 rounded-control px-2 text-muted hover:bg-surface hover:text-fg aria-disabled:opacity-50"
                  aria-label={`Open ${attachment.filename}`}
                  onClick={event => {
                    if (!src) event.preventDefault();
                  }}
                >
                  <ExternalLink size={14} aria-hidden="true" /> Open
                </a>
              )}
              <a
                {...(src ? { href: src, download: attachment.filename } : {})}
                aria-disabled={!src}
                className="inline-flex min-h-[44px] min-w-[44px] items-center gap-1 rounded-control px-2 text-muted hover:bg-surface hover:text-fg aria-disabled:opacity-50"
                aria-label={`Download ${attachment.filename}`}
                onClick={event => {
                  if (!src) event.preventDefault();
                }}
              >
                <Download size={14} aria-hidden="true" /> Download
              </a>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

const AttachmentCacheContext = createContext<AttachmentBlobCache | null>(null);

function isImageAttachment(image: TranscriptImage): boolean {
  return (
    image.kind === 'inline' ||
    isImageMime(image.mime) ||
    (!image.mime && /\.(?:png|jpe?g|gif|webp)$/i.test(image.filename))
  );
}

export function AttachmentImageProvider({ children }: { children: ReactNode }) {
  const cache = useRef<AttachmentBlobCache | null>(null);
  cache.current ??= new AttachmentBlobCache();
  useEffect(() => () => cache.current?.dispose(), []);
  return <AttachmentCacheContext.Provider value={cache.current}>{children}</AttachmentCacheContext.Provider>;
}

function useVisible(ref: RefObject<HTMLElement | null>, eager: boolean): boolean {
  const [visible, setVisible] = useState(eager);
  useEffect(() => {
    if (visible || eager) return;
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '320px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [eager, ref, visible]);
  return visible;
}

function AttachmentThumbnail({ image }: { image: TranscriptImage }) {
  const sharedCache = useContext(AttachmentCacheContext);
  const localCache = useRef<AttachmentBlobCache | null>(null);
  localCache.current ??= new AttachmentBlobCache(1);
  useEffect(() => () => localCache.current?.dispose(), []);
  const cache = sharedCache ?? localCache.current;

  const host = useRef<HTMLDivElement | null>(null);
  const visible = useVisible(host, image.kind === 'inline');
  const [src, setSrc] = useState(image.kind === 'inline' ? image.src : '');
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // `open` on a <dialog> is modeless. showModal() supplies the real top layer,
  // backdrop, pointer inertness and accessibility modality promised below.
  // Declare this layout effect before useDialogFocus so the dialog enters the
  // top layer before that hook moves focus into it.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!expanded || !src || !dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [expanded, src]);
  const dialogFocus = useDialogFocus(expanded, dialogRef, () => setExpanded(false));

  useEffect(() => {
    setExpanded(false);
    setFailed(false);
    if (image.kind === 'inline') {
      setSrc(image.src);
      return;
    }
    setSrc('');
    if (!visible) return;
    const key = `${image.sessionId}/${image.attachmentId}`;
    let active = true;
    void cache
      .acquire(key, async () => {
        const blob = await api.attachment(image.sessionId, image.attachmentId);
        if (!isImageMime(blob.type)) throw new Error('attachment response was not an image');
        return blob;
      })
      .then(url => {
        if (active) setSrc(url);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      cache.release(key);
    };
  }, [cache, image, visible]);

  const filename = image.kind === 'attachment' ? image.filename : image.alt;
  const alt = image.kind === 'attachment' ? (image.alt ?? image.filename) : image.alt;
  const size = image.kind === 'attachment' ? formatAttachmentSize(image.size) : '';

  return (
    <div ref={host} className="min-w-0">
      {failed ? (
        <div className="flex min-h-[72px] min-w-[160px] items-center gap-2 rounded-control border border-border-soft bg-surface-2 px-3 py-2 text-left text-meta text-muted">
          <ImageOff size={18} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate text-fg-soft">{filename}</span>
            {size && <span className="block text-faint">{size}</span>}
            <span className="block text-warn">no longer available</span>
          </span>
        </div>
      ) : src ? (
        <button
          type="button"
          className="block min-h-[44px] min-w-[44px] overflow-hidden rounded-control border border-border-soft bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => setExpanded(true)}
          aria-label={`Expand ${alt}`}
        >
          <img
            src={src}
            alt={alt}
            loading="lazy"
            className="max-h-[280px] max-w-full object-contain"
            onError={() => setFailed(true)}
          />
        </button>
      ) : (
        <div
          className="min-h-[72px] min-w-[160px] animate-pulse rounded-control border border-border-soft bg-surface-2 motion-reduce:animate-none"
          role="status"
          aria-label={`Loading ${alt}`}
        />
      )}

      {expanded && src && (
        <dialog
          ref={dialogRef}
          tabIndex={-1}
          aria-modal="true"
          {...dialogFocus}
          className="fixed inset-0 z-50 m-auto max-h-[96dvh] max-w-[96vw] overflow-auto rounded-panel border border-border bg-surface p-2 text-fg shadow-2xl backdrop:bg-black/70"
          aria-label={`Expanded image: ${alt}`}
          onCancel={event => {
            event.preventDefault();
            setExpanded(false);
          }}
          onClose={() => setExpanded(false)}
          onClick={event => {
            if (event.currentTarget === event.target) setExpanded(false);
          }}
        >
          <div className="relative min-h-[44px] min-w-[44px]">
            <button
              type="button"
              className="absolute right-0 top-0 z-10 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-control border border-border bg-surface/90 text-fg shadow"
              onClick={() => setExpanded(false)}
              aria-label="Close expanded image"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <img src={src} alt={alt} className="h-auto max-h-[90dvh] max-w-[92vw] object-contain" />
          </div>
        </dialog>
      )}
    </div>
  );
}

export function TranscriptImageGallery({
  images,
  initialLimit,
  className,
}: {
  images: TranscriptImage[];
  /** Tool groups show four at rest; user messages omit this and show all. */
  initialLimit?: number;
  className?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  if (images.length === 0) return null;
  const visible = initialLimit && !showAll ? images.slice(0, initialLimit) : images;
  const hidden = images.length - visible.length;
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {visible.map((image, index) =>
          image.kind === 'attachment' && !isImageAttachment(image) ? (
            <AttachmentDocumentCard key={`${image.sessionId}/${image.attachmentId}/${index}`} attachment={image} />
          ) : (
            <AttachmentThumbnail
              key={
                image.kind === 'attachment'
                  ? `${image.sessionId}/${image.attachmentId}/${index}`
                  : `${image.alt}/${image.src.length}/${index}`
              }
              image={image}
            />
          ),
        )}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          className="inline-flex min-h-[44px] items-center rounded-control px-2 text-meta text-muted hover:bg-surface-2 hover:text-fg"
          onClick={() => setShowAll(true)}
        >
          Show {hidden} more attachment{hidden === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}
