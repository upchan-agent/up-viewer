'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ImgHTMLAttributes, ReactNode, SyntheticEvent } from 'react';

export type ImageTransportStatus = 'loading' | 'loaded' | 'failed' | 'timeout';

// Successful decodes are shared across list and popup instances. A popup that
// successfully retries a slow image immediately repairs the corresponding list
// row instead of leaving that row stuck on its fallback.
const MAX_DECODED_URLS = 1_000;
let decodeRevision = 0;
const decodedUrlRevisions = new Map<string, number>();
const decodedUrlSubscribers = new Map<string, Set<() => void>>();

function getDecodedRevision(src: string): number {
  return decodedUrlRevisions.get(src) ?? 0;
}

function getServerDecodedRevision(): number {
  return 0;
}

function notifyDecodedUrl(src: string) {
  decodedUrlSubscribers.get(src)?.forEach(notify => notify());
}

function markUrlDecoded(src: string) {
  if (decodedUrlRevisions.has(src)) decodedUrlRevisions.delete(src);
  decodedUrlRevisions.set(src, ++decodeRevision);

  if (decodedUrlRevisions.size > MAX_DECODED_URLS) {
    const oldest = decodedUrlRevisions.keys().next().value;
    if (oldest) {
      decodedUrlRevisions.delete(oldest);
      notifyDecodedUrl(oldest);
    }
  }
  notifyDecodedUrl(src);
}

function subscribeToDecodedUrl(src: string, notify: () => void): () => void {
  if (!decodedUrlSubscribers.has(src)) decodedUrlSubscribers.set(src, new Set());
  decodedUrlSubscribers.get(src)!.add(notify);
  return () => {
    const subscribers = decodedUrlSubscribers.get(src);
    if (!subscribers) return;
    subscribers.delete(notify);
    if (subscribers.size === 0) decodedUrlSubscribers.delete(src);
  };
}

function PendingImageGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" focusable="false" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="5.25" cy="6" r="1" fill="currentColor" />
      <path d="M3.75 11 7 8.25l2 1.75 1.5-1.25L13 11" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ImagePending() {
  return (
    <span className="uv-image-pending" aria-hidden="true">
      <PendingImageGlyph />
    </span>
  );
}

interface ErrorImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'style' | 'onLoad' | 'onError'> {
  src: string;
  style?: CSSProperties;
  fallback?: ReactNode;
  /** Static content shown until the browser finishes decoding the image. */
  pendingFallback?: ReactNode;
  /** Stop a visible image request that has not completed within this window. */
  timeoutMs?: number;
  onStatusChange?: (status: ImageTransportStatus, src: string) => void;
  onLoad?: (event: SyntheticEvent<HTMLImageElement>) => void;
  onError?: (event: SyntheticEvent<HTMLImageElement>) => void;
}

/**
 * Image with explicit transport state.
 *
 * URL resolution and browser image loading are separate phases. When
 * pendingFallback is provided, the frame stays visible with a static pending
 * marker until the image has loaded and decoded. There is deliberately no
 * transition: the decoded image replaces the marker immediately.
 */
export function ErrorImage({
  src,
  alt = '',
  style,
  className,
  onLoad,
  onError,
  fallback,
  pendingFallback,
  timeoutMs = 20_000,
  onStatusChange,
  loading = 'lazy',
  decoding = 'async',
  fetchPriority = 'low',
  ...imgProps
}: ErrorImageProps) {
  const [imageState, setImageState] = useState<{
    src: string;
    status: ImageTransportStatus;
    failureRevision?: number;
  }>({ src, status: 'loading' });
  const frameRef = useRef<HTMLSpanElement>(null);
  const currentSrcRef = useRef(src);
  currentSrcRef.current = src;

  const subscribeToCurrentUrl = useCallback(
    (notify: () => void) => subscribeToDecodedUrl(src, notify),
    [src],
  );
  const getCurrentRevision = useCallback(() => getDecodedRevision(src), [src]);
  const sharedRevision = useSyncExternalStore(
    subscribeToCurrentUrl,
    getCurrentRevision,
    getServerDecodedRevision,
  );

  // A changed src is loading immediately during render. Shared success repairs
  // an older local failure only when its revision is newer; a current-instance
  // failure must override stale shared success.
  const currentState = imageState.src === src
    ? imageState
    : { src, status: 'loading' as ImageTransportStatus };
  const isLocalFailure = currentState.status === 'failed' || currentState.status === 'timeout';
  const hasNewerSharedSuccess = sharedRevision > 0
    && (!isLocalFailure || sharedRevision > (currentState.failureRevision ?? sharedRevision));
  const status: ImageTransportStatus = hasNewerSharedSuccess ? 'loaded' : currentState.status;
  const hasPendingFallback = pendingFallback != null;

  useEffect(() => {
    onStatusChange?.(status, src);
  }, [onStatusChange, src, status]);

  useEffect(() => {
    if (!hasPendingFallback || status !== 'loading' || timeoutMs <= 0) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: IntersectionObserver | undefined;
    const requestSrc = src;
    const startTimer = () => {
      if (timer) return;
      timer = setTimeout(() => {
        if (currentSrcRef.current === requestSrc) {
          setImageState({ src: requestSrc, status: 'timeout', failureRevision: sharedRevision });
        }
      }, timeoutMs);
    };

    const frame = frameRef.current;
    if (!frame || typeof IntersectionObserver === 'undefined') {
      startTimer();
    } else {
      observer = new IntersectionObserver((entries) => {
        if (entries.some(entry => entry.isIntersecting)) {
          startTimer();
          observer?.disconnect();
        }
      });
      observer.observe(frame);
    }

    return () => {
      observer?.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [src, status, timeoutMs, hasPendingFallback, sharedRevision]);

  const handleLoad = async (event: SyntheticEvent<HTMLImageElement>) => {
    const loadedSrc = src;
    const image = event.currentTarget;
    onLoad?.(event);

    try {
      await image.decode();
    } catch {
      // Some valid formats do not support decode(); naturalWidth confirms that
      // the browser still produced a usable image.
      if (image.naturalWidth === 0) {
        if (currentSrcRef.current === loadedSrc) {
          setImageState({ src: loadedSrc, status: 'failed', failureRevision: sharedRevision });
        }
        return;
      }
    }

    if (image.isConnected && currentSrcRef.current === loadedSrc) {
      markUrlDecoded(loadedSrc);
      setImageState({ src: loadedSrc, status: 'loaded' });
    }
  };

  const handleError = (event: SyntheticEvent<HTMLImageElement>) => {
    if (currentSrcRef.current === src) {
      setImageState({ src, status: 'failed', failureRevision: sharedRevision });
    }
    onError?.(event);
  };

  if (status === 'failed' || status === 'timeout') return <>{fallback ?? null}</>;

  if (!pendingFallback) {
    return (
      <img
        {...imgProps}
        src={src}
        alt={alt}
        style={style}
        className={className}
        loading={loading}
        decoding={decoding}
        fetchPriority={fetchPriority}
        onLoad={handleLoad}
        onError={handleError}
      />
    );
  }

  const {
    objectFit,
    objectPosition,
    ...frameStyle
  } = style ?? {};

  const imageStyle: CSSProperties = {
    gridArea: '1 / 1',
    width: '100%',
    height: '100%',
    minWidth: 0,
    minHeight: 0,
    objectFit,
    objectPosition,
    borderRadius: 'inherit',
    display: 'block',
  };

  return (
    <span
      ref={frameRef}
      className={className}
      style={{
        ...frameStyle,
        display: 'grid',
        placeItems: 'center',
        position: 'relative',
        isolation: 'isolate',
      }}
      aria-busy={status === 'loading'}
    >
      {status === 'loading' && (
        <span
          style={{
            gridArea: '1 / 1',
            zIndex: 1,
            width: '100%',
            height: '100%',
            display: 'grid',
            placeItems: 'center',
            borderRadius: 'inherit',
            background: 'var(--color-state-resolving)',
          }}
        >
          {pendingFallback}
        </span>
      )}
      <img
        {...imgProps}
        src={src}
        alt={alt}
        style={imageStyle}
        loading={loading}
        decoding={decoding}
        fetchPriority={fetchPriority}
        onLoad={handleLoad}
        onError={handleError}
      />
    </span>
  );
}
