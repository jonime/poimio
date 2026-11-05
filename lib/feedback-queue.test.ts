import { describe, expect, it, vi } from "vitest";
import { FeedbackMutationQueue, type FeedbackState } from "./feedback-queue.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("FeedbackMutationQueue", () => {
  it("serializes rapid changes and leaves the last requested state on the server", async () => {
    const firstSave = deferred();
    const save = vi
      .fn<(state: FeedbackState) => Promise<void>>()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValue(undefined);
    const queue = new FeedbackMutationQueue(null, save, vi.fn());

    queue.enqueue({ kind: "like", via: "button" });
    queue.enqueue({ kind: "not_interested", via: "button" });
    queue.enqueue({ kind: "seen", via: "button" });
    expect(save).toHaveBeenCalledTimes(1);

    firstSave.resolve();
    await queue.whenIdle();

    expect(save.mock.calls.map(([state]) => state)).toEqual([
      { kind: "like", via: "button" },
      { kind: "not_interested", via: "button" },
      { kind: "seen", via: "button" },
    ]);
    expect(queue.snapshot.confirmed).toEqual({ kind: "seen", via: "button" });
  });

  it("undoes a pending Seen back to the exact previous swipe Like state", async () => {
    const firstSave = deferred();
    const initialState = { kind: "like", via: "swipe" } as const;
    const save = vi
      .fn<(state: FeedbackState) => Promise<void>>()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValue(undefined);
    const queue = new FeedbackMutationQueue(initialState, save, vi.fn());

    queue.enqueue({ kind: "seen", via: "button" });
    queue.enqueue(initialState);
    firstSave.resolve();
    await queue.whenIdle();

    expect(save.mock.calls.map(([state]) => state)).toEqual([
      { kind: "seen", via: "button" },
      { kind: "like", via: "swipe" },
    ]);
    expect(queue.snapshot.confirmed).toEqual(initialState);
  });

  it("drops queued changes and reverts to the last confirmed state after failure", async () => {
    const firstSave = deferred();
    const confirmedState = { kind: "like", via: "swipe" } as const;
    const save = vi
      .fn<(state: FeedbackState) => Promise<void>>()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValue(undefined);
    const queue = new FeedbackMutationQueue(confirmedState, save, vi.fn());

    queue.enqueue({ kind: "seen", via: "button" });
    queue.enqueue({ kind: "not_interested", via: "button" });
    firstSave.reject(new Error("network failure"));
    await queue.whenIdle();

    expect(save).toHaveBeenCalledExactlyOnceWith({
      kind: "seen",
      via: "button",
    });
    expect(queue.snapshot).toMatchObject({
      confirmed: confirmedState,
      displayed: confirmedState,
      saving: false,
      error: "Could not save your feedback. Please try again.",
    });
  });

  it("restores an un-rated item with clearFeedback state", async () => {
    const save = vi.fn<(state: FeedbackState) => Promise<void>>().mockResolvedValue(undefined);
    const queue = new FeedbackMutationQueue(null, save, vi.fn());

    queue.enqueue({ kind: "seen", via: "button" });
    queue.enqueue(null);
    await queue.whenIdle();

    expect(save.mock.calls.map(([state]) => state)).toEqual([
      { kind: "seen", via: "button" },
      null,
    ]);
    expect(queue.snapshot.confirmed).toBeNull();
  });
});
