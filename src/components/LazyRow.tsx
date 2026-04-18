'use client';

import { useRef, useEffect, useState, useCallback } from 'react';

/**
 * Intersection Observer による遅延マウント。
 *
 * viewport（または rootMargin 拡張領域）に入るまで children をマウントしない。
 * 一度マウントしたら unmount しない（画像の再読み込みを防ぐ）。
 */
export function LazyRow({
  children,
  rootMargin = '200px',
  placeholder,
}: {
  children: React.ReactNode;
  rootMargin?: string;
  placeholder?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const mounted = useRef(false);

  const setMounted = useCallback(() => {
    if (!mounted.current) {
      mounted.current = true;
      setVisible(true);
    }
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // すでに visible なら observer は不要
    if (visible) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMounted();
          observer.disconnect();
        }
      },
      { rootMargin }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, rootMargin, setMounted]);

  return (
    <div ref={ref}>
      {visible ? children : placeholder ?? <div style={{ height: 48 }} />}
    </div>
  );
}
