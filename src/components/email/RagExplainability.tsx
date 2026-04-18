import { useState } from "react";
import { Brain, ChevronDown, ChevronRight, FileText } from "lucide-react";

interface RagExplainabilityProps {
  contextItems?: any[];
}

export function RagExplainability({ contextItems = [] }: RagExplainabilityProps) {
  const [expanded, setExpanded] = useState(false);

  if (!contextItems || contextItems.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 rounded-lg border app-border bg-[color:var(--surface-sunken)] p-3 overflow-hidden">
      <button 
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-sm font-medium app-text-secondary hover:text-[color:var(--text-primary)] transition-colors"
      >
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-[color:var(--text-muted)]" />
          <span>Why this reply? ({contextItems.length} sources)</span>
        </div>
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2">
          {contextItems.map((item, i) => (
            <div key={i} className="rounded-md border app-border bg-[color:var(--surface-elevated)] p-2.5 text-[13px]">
              <div className="flex items-center gap-2 mb-1.5">
                <FileText className="h-3.5 w-3.5 text-[color:var(--text-muted)]" />
                <span className="font-semibold truncate max-w-[200px] sm:max-w-xs">{item.subject || "Subject unknown"}</span>
                <span className="text-[10px] app-text-tertiary ml-auto">Score: {(item.final_score * 100).toFixed(1)}%</span>
              </div>
              <div className="text-[12px] app-text-secondary line-clamp-3 leading-relaxed pl-5 whitespace-pre-wrap">
                {item.text}
              </div>
              
              <div className="mt-2 pl-5 flex gap-2">
                 <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold ${item.tier === 'strong' ? 'bg-emerald-500/10 text-emerald-600' : item.tier === 'medium' ? 'bg-amber-500/10 text-amber-600' : 'bg-gray-500/10 text-gray-600'}`}>
                    {item.tier} match
                 </span>
                 {item.is_thread_local && (
                   <span className="px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold bg-[color:var(--surface-secondary)] text-[color:var(--text-secondary)] ring-1 ring-[color:var(--border-soft)]">
                     From Thread
                   </span>
                 )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
