import { EventEmitter } from "node:events";
import type { Phase } from "../state/project-state.js";

export interface ProgressEvents {
  "phase:start": { phase: Phase; index: number; total: number };
  "phase:end": { phase: Phase; success: boolean; elapsed: number };
  "batch:start": { index: number; total: number; taskCount: number };
  "batch:end": { index: number; success: boolean };
  "task:start": { taskId: string; title: string };
  "task:end": { taskId: string; success: boolean };
  "shutdown": { phase: Phase };
}

type EventName = keyof ProgressEvents;

class ProgressEmitter {
  private emitter = new EventEmitter();

  emit<K extends EventName>(event: K, data: ProgressEvents[K]): void {
    this.emitter.emit(event, data);
  }

  on<K extends EventName>(event: K, listener: (data: ProgressEvents[K]) => void): void {
    this.emitter.on(event, listener);
  }

  off<K extends EventName>(event: K, listener: (data: ProgressEvents[K]) => void): void {
    this.emitter.off(event, listener);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

export const progress = new ProgressEmitter();
