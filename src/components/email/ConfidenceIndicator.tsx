import { AlertCircle, CheckCircle, HelpCircle } from "lucide-react";

interface ConfidenceIndicatorProps {
  confidence: number | null;
  mode: "manual" | "assist" | "auto";
  autoSendThreshold?: number;
}

export function ConfidenceIndicator({ confidence, mode, autoSendThreshold = 0.7 }: ConfidenceIndicatorProps) {
  if (confidence === null || confidence === undefined) return null;

  const pct = Math.round(confidence * 100);
  
  let colorClass = "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  let Icon = HelpCircle;
  let text = `Unknown (${pct}%)`;

  if (confidence >= 0.8) {
    colorClass = "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-400";
    Icon = CheckCircle;
    text = `High Confidence (${pct}%)`;
  } else if (confidence >= 0.5) {
    colorClass = "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-400";
    Icon = AlertCircle;
    text = `Medium Confidence (${pct}%)`;
  } else {
    colorClass = "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-400";
    Icon = AlertCircle;
    text = `Low Confidence (${pct}%)`;
  }

  return (
    <div className="flex items-center gap-2">
      <div className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${colorClass}`}>
        <Icon className="h-3 w-3" />
        <span>{text}</span>
      </div>
      
      {mode === "auto" && confidence < autoSendThreshold && (
        <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
          Below auto-send threshold — requires review
        </span>
      )}
    </div>
  );
}
