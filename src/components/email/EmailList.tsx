"use client";

import React, { useEffect, useRef, useState } from "react";
import { EmailRow, type EmailListItem } from "./EmailRow";
import { EmailRowSkeleton } from "../ui/Skeleton";

type EmailListProps = {
  emails: EmailListItem[];
  selectedId: number | null;
  categoryColors?: Record<string, string>;
  onSelect: (id: number) => void;
  onGenerate?: (id: number) => void;
  onSend?: (id: number) => void;
  onArchive?: (id: number) => void;
  onToggleSeen?: (id: number) => void;
  onOpenInGmail?: (id: number) => void;
  actionLoading?: string | null;
  onLoadMore?: () => void;
  isLoading?: boolean;
  hasMore?: boolean;
  emptyMessage?: string;
  showActions?: boolean;
  onScrollPositionChange?: (scrollTop: number) => void;
};

export function EmailList({ 
  emails, 
  selectedId, 
  categoryColors,
  onSelect, 
  onGenerate = () => {},
  onSend = () => {},
  onArchive = () => {},
  onToggleSeen = () => {},
  onOpenInGmail = () => {},
  actionLoading = null,
  onLoadMore, 
  isLoading = false,
  hasMore = false,
  emptyMessage = "No emails found.",
  showActions = true,
  onScrollPositionChange,
}: EmailListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 20 });
  const rowHeight = 112; // Keep in sync with EmailRow min-height to avoid virtualized overlap/overflow.

  // TIER 3 OPTIMIZATION: Simple Virtualization (Windowing)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      const top = el.scrollTop;
      const height = el.clientHeight;
      onScrollPositionChange?.(top);
      const start = Math.max(0, Math.floor(top / rowHeight) - 5);
      const end = Math.min(emails.length, Math.ceil((top + height) / rowHeight) + 5);
      setVisibleRange({ start, end });
    };

    el.addEventListener("scroll", handleScroll);
    handleScroll();
    return () => el.removeEventListener("scroll", handleScroll);
  }, [emails.length, onScrollPositionChange]);

  // TIER 3 OPTIMIZATION: Infinite Scroll (Intersection Observer)
  const observerRef = useRef<IntersectionObserver | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!onLoadMore || !hasMore || isLoading) return;

    if (observerRef.current) observerRef.current.disconnect();

    observerRef.current = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry?.isIntersecting) {
        onLoadMore();
      }
    }, { threshold: 0.1 });

    if (bottomRef.current) observerRef.current.observe(bottomRef.current);

    return () => observerRef.current?.disconnect();
  }, [onLoadMore, hasMore, isLoading]);

  if (emails.length === 0 && !isLoading) {
    return <div className="p-8 text-center text-sm app-text-muted">{emptyMessage}</div>;
  }

  const paddingTop = visibleRange.start * rowHeight;
  const paddingBottom = Math.max(0, (emails.length - visibleRange.end) * rowHeight);

  return (
    <div ref={scrollRef} className="flex flex-col h-full overflow-y-auto overflow-x-hidden relative scroll-smooth">
      <div style={{ paddingTop, paddingBottom }} className="flex flex-col">
        {emails.slice(visibleRange.start, visibleRange.end).map((e) => (
          <EmailRow
            key={e.id}
            email={e}
            isSelected={selectedId === e.id}
            categoryColors={categoryColors}
            onClick={() => onSelect(e.id)}
            onGenerate={onGenerate}
            onSend={onSend}
            onArchive={onArchive}
            onToggleSeen={onToggleSeen}
            onOpenInGmail={onOpenInGmail}
            actionLoading={actionLoading}
            showActions={showActions}
          />
        ))}
      </div>

      {isLoading && emails.length > 0 && (
        <div className="py-4">
          <EmailRowSkeleton />
          <EmailRowSkeleton />
        </div>
      )}

      {emails.length === 0 && isLoading && (
        <div className="flex flex-col h-full">
          {[...Array(6)].map((_, i) => <EmailRowSkeleton key={i} />)}
        </div>
      )}

      <div ref={bottomRef} style={{ height: 20 }} className="flex-shrink-0" />
    </div>
  );
}
