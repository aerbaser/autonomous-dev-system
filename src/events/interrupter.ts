import type { Phase } from "../state/project-state.js";

export class Interrupter {
  private controller: AbortController;
  private interrupted = false;
  private reason: string | undefined;
  private redirectPhase: Phase | undefined;

  constructor() {
    this.controller = new AbortController();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  interrupt(reason: string, redirectPhase?: Phase): void {
    this.interrupted = true;
    this.reason = reason;
    this.redirectPhase = redirectPhase;
    this.controller.abort(reason);
  }

  isInterrupted(): boolean {
    return this.interrupted;
  }

  getRedirectPhase(): Phase | undefined {
    return this.redirectPhase;
  }

  getReason(): string | undefined {
    return this.reason;
  }

  reset(): void {
    this.interrupted = false;
    this.reason = undefined;
    this.redirectPhase = undefined;
    this.controller = new AbortController();
  }

  requestShutdown(): void {
    this.interrupt("user-shutdown");
  }
}
