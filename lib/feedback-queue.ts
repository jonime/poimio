export type FeedbackKind = "like" | "not_interested" | "seen";
export type FeedbackVia = "button" | "swipe";

export interface FeedbackValue {
  kind: FeedbackKind;
  via: FeedbackVia;
}

export type FeedbackState = FeedbackValue | null;

export interface FeedbackQueueSnapshot {
  confirmed: FeedbackState;
  displayed: FeedbackState;
  saving: boolean;
  error: string | null;
}

type SaveFeedback = (state: FeedbackState) => Promise<void>;
type OnChange = (snapshot: FeedbackQueueSnapshot) => void;

function copyState(state: FeedbackState): FeedbackState {
  return state ? { ...state } : null;
}

export class FeedbackMutationQueue {
  private confirmed: FeedbackState;
  private displayed: FeedbackState;
  private saving = false;
  private error: string | null = null;
  private running = false;
  private readonly pending: FeedbackState[] = [];
  private readonly idleWaiters: Array<() => void> = [];

  constructor(
    initialState: FeedbackState,
    private readonly save: SaveFeedback,
    private readonly onChange: OnChange,
  ) {
    this.confirmed = copyState(initialState);
    this.displayed = copyState(initialState);
  }

  get snapshot(): FeedbackQueueSnapshot {
    return {
      confirmed: copyState(this.confirmed),
      displayed: copyState(this.displayed),
      saving: this.saving,
      error: this.error,
    };
  }

  enqueue(state: FeedbackState): void {
    this.displayed = copyState(state);
    this.error = null;
    this.pending.push(copyState(state));
    this.notify();
    void this.processQueue();
  }

  whenIdle(): Promise<void> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Queue processing mutates running across calls.
    if (!this.running && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async processQueue(): Promise<void> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Prevent concurrent processing while a save is pending.
    if (this.running) return;
    this.running = true;
    this.saving = true;
    this.notify();

    while (this.pending.length > 0) {
      const nextState = this.pending.shift();
      if (nextState === undefined) break;
      try {
        await this.save(copyState(nextState));
        this.confirmed = copyState(nextState);
        this.notify();
      } catch {
        this.pending.length = 0;
        this.displayed = copyState(this.confirmed);
        this.error = "Could not save your feedback. Please try again.";
        this.notify();
        break;
      }
    }

    this.saving = false;
    this.running = false;
    this.notify();
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private notify(): void {
    this.onChange(this.snapshot);
  }
}
