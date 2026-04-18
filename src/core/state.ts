import type { EmailState } from "../db/emails";

const transitions: Record<EmailState, EmailState[]> = {
  INGESTED: ["PROCESSING", "ERROR_TEMP", "ERROR_FATAL", "DEAD"],
  PROCESSING: ["CLASSIFIED", "ERROR_TEMP", "ERROR_FATAL", "DEAD"],
  CLASSIFIED: ["READY_TO_GENERATE", "ERROR_TEMP", "ERROR_FATAL", "DEAD"],
  READY_TO_GENERATE: ["GENERATED", "ERROR_TEMP", "ERROR_FATAL", "DEAD"],
  GENERATED: ["AWAITING_REVIEW", "READY_TO_SEND", "ERROR_TEMP", "ERROR_FATAL", "DEAD"],
  AWAITING_REVIEW: ["READY_TO_SEND", "READY_TO_GENERATE", "ERROR_TEMP", "ERROR_FATAL", "DEAD"],
  READY_TO_SEND: ["SENT", "AWAITING_REVIEW", "ERROR_TEMP", "ERROR_FATAL", "DEAD"],
  SENT: [],
  REPLIED: [],
  ERROR_TEMP: ["PROCESSING", "CLASSIFIED", "READY_TO_GENERATE", "GENERATED", "AWAITING_REVIEW", "READY_TO_SEND", "ERROR_FATAL", "DEAD"],
  ERROR_FATAL: [],
  DEAD: [],
};

export function canTransition(current: EmailState, next: EmailState): boolean {
  return transitions[current].includes(next);
}

export function assertTransition(current: EmailState, next: EmailState): void {
  if (!canTransition(current, next)) {
    throw new Error(`Invalid state transition: ${current} -> ${next}`);
  }
}
