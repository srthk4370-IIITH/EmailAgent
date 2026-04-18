"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { requiresPersistentGuidance, type AppError } from "../../lib/errorNormalizer";

type ErrorCenterState = {
  globalError: AppError | null;
  retryAction: (() => Promise<void>) | null;
  canDismissGlobalError: boolean;
  setGlobalError: (error: AppError | null, retryAction?: (() => Promise<void>) | null) => void;
  clearGlobalError: (options?: { force?: boolean }) => void;
};

const ErrorCenterContext = createContext<ErrorCenterState | null>(null);

export function ErrorCenterProvider({ children }: { children: ReactNode }) {
  const [globalError, setGlobalErrorState] = useState<AppError | null>(null);
  const [retryAction, setRetryAction] = useState<(() => Promise<void>) | null>(null);
  const [dismissLocked, setDismissLocked] = useState(false);

  const setGlobalError = useCallback((error: AppError | null, retry?: (() => Promise<void>) | null) => {
    setGlobalErrorState(error);
    setRetryAction(retry ?? null);
    setDismissLocked(Boolean(error && requiresPersistentGuidance(error)));
  }, []);

  const clearGlobalError = useCallback((options?: { force?: boolean }) => {
    if (!options?.force && dismissLocked) return;
    setGlobalErrorState(null);
    setRetryAction(null);
    setDismissLocked(false);
  }, [dismissLocked]);

  const value = useMemo<ErrorCenterState>(
    () => ({
      globalError,
      retryAction,
      canDismissGlobalError: !dismissLocked,
      setGlobalError,
      clearGlobalError,
    }),
    [clearGlobalError, dismissLocked, globalError, retryAction, setGlobalError],
  );

  return <ErrorCenterContext.Provider value={value}>{children}</ErrorCenterContext.Provider>;
}

export function useErrorCenter(): ErrorCenterState {
  const context = useContext(ErrorCenterContext);
  if (!context) {
    throw new Error("useErrorCenter must be used inside ErrorCenterProvider");
  }
  return context;
}
