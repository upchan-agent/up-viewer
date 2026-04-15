'use client';

import { useState } from 'react';

/**
 * ErrorImage - エラー時のみフォールバック表示する画像コンポーネント
 * 
 * 画像の読み込みに失敗した場合にのみフォールバックコンテンツを表示します。
 * ロード中は通常のimgタグとして表示され、エラー時にfallbackが表示されます。
 */
export function ErrorImage({ 
  src, 
  alt, 
  style, 
  className, 
  onLoad, 
  fallback 
}: {
  src: string;
  alt?: string;
  style?: React.CSSProperties;
  className?: string;
  onLoad?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  fallback?: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) return <>{fallback ?? null}</>;
  return (
    <img
      src={src}
      alt={alt ?? ''}
      style={style}
      className={className}
      onLoad={onLoad}
      onError={() => setFailed(true)}
    />
  );
}
