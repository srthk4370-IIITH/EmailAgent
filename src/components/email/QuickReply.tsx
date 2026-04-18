"use client";

import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Paperclip, Send } from "lucide-react";

interface QuickReplyProps {
  emailId: number;
  threadId: string;
  subject: string;
  to: string;
  initialText?: string | null;
  onSuccess?: () => void;
}

export function QuickReply({ emailId, threadId, subject, to, initialText, onSuccess }: QuickReplyProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [hasEdited, setHasEdited] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText(initialText ?? "");
    setHasEdited(false);
    setStatus("idle");
    setErrorMsg("");
    setAttachments([]);
  }, [emailId, initialText]);

  useEffect(() => {
    if (!hasEdited) {
      setText(initialText ?? "");
    }
  }, [initialText, hasEdited]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.max(160, textareaRef.current.scrollHeight)}px`;
    }
  }, [text]);

  async function handleSend() {
    if (!text.trim()) return;
    setSending(true);
    setStatus("idle");
    try {
      const form = new FormData();
      form.set("to", to);
      form.set("subject", subject);
      form.set("body", text);
      form.set("threadId", threadId);
      for (const file of attachments) {
        form.append("attachments", file);
      }

      const res = await fetch("/api/compose/send", {
        method: "POST",
        body: form,
      });

      const data = await res.json();
      if (res.ok) {
        setText("");
        setHasEdited(false);
        setAttachments([]);
        setStatus("success");
        setTimeout(() => onSuccess?.(), 1200);
      } else {
        setStatus("error");
        setErrorMsg(data.error || "Failed to send");
      }
    } catch {
      setStatus("error");
      setErrorMsg("Network error occurred");
    } finally {
      setSending(false);
    }
  }

  function onPickFiles(next: FileList | null) {
    if (!next) return;
    const incoming = Array.from(next);
    setAttachments((prev) => [...prev, ...incoming]);
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <section className="rounded-lg border app-border bg-[color:var(--surface-elevated)] shadow-sm">
      <div className="border-b app-border px-5 py-4">
        <div className="font-semibold text-[13px] app-text-primary">Reply to this message</div>
        <div className="mt-1 text-[12px] app-text-tertiary">To: {to}</div>
      </div>

      <div className="px-5 py-5">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setHasEdited(true);
            setText(e.target.value);
          }}
          placeholder={initialText ? "AI draft loaded. Edit before sending..." : "Write your reply here..."}
          className="app-input app-focus-ring min-h-[120px] w-full resize-none rounded-lg px-4 py-3 text-[13px] leading-relaxed"
          disabled={sending || status === "success"}
        />

        {attachments.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {attachments.map((file, index) => (
              <button
                key={`${file.name}-${index}`}
                type="button"
                onClick={() => removeAttachment(index)}
                className="app-chip rounded-lg px-2.5 py-1 text-[11px] hover:opacity-80 app-motion-fast"
                title="Remove attachment"
              >
                {file.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t app-border px-5 py-4">
        <div className="inline-flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => onPickFiles(event.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || status === "success"}
            className="app-button-secondary inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] app-motion-fast disabled:opacity-50"
          >
            <Paperclip className="h-3.5 w-3.5" />
            Attach
          </button>
          {attachments.length > 0 && (
            <span className="text-[11px] app-text-tertiary">{attachments.length} file{attachments.length !== 1 ? 's' : ''}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {status === "error" && (
            <div className="text-[11px] app-state-error px-2 py-1 rounded">
              {errorMsg}
            </div>
          )}
          {status === "success" && (
            <div className="inline-flex items-center gap-1 text-[11px] app-state-success px-2 py-1 rounded">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Sent
            </div>
          )}
          <button
            onClick={handleSend}
            disabled={sending || !text.trim() || status === "success"}
            className="app-button-primary inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium app-motion-fast disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </section>
  );
}
