export type SwipeDirectionLock = "undecided" | "horizontal" | "vertical";
export type SwipeAction = "like" | "not_interested";

export interface SwipeGesture {
  startX: number;
  startY: number;
  width: number;
  deltaX: number;
  lock: SwipeDirectionLock;
}

export interface SwipeResult {
  action: SwipeAction | null;
  deltaX: number;
}

export function beginSwipe(startX: number, startY: number, width: number): SwipeGesture {
  return {
    startX,
    startY,
    width: Math.max(0, width),
    deltaX: 0,
    lock: "undecided",
  };
}

export function moveSwipe(
  gesture: SwipeGesture,
  currentX: number,
  currentY: number,
  slop = 10,
): SwipeGesture {
  const deltaX = currentX - gesture.startX;
  const deltaY = currentY - gesture.startY;

  if (gesture.lock === "vertical") return { ...gesture, deltaX: 0 };
  if (gesture.lock === "horizontal") return { ...gesture, deltaX };
  if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) <= slop) return gesture;

  const lock = Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
  return {
    ...gesture,
    lock,
    deltaX: lock === "horizontal" ? deltaX : 0,
  };
}

export function finishSwipe(gesture: SwipeGesture): SwipeResult {
  const threshold = gesture.width * 0.4;
  if (gesture.lock !== "horizontal" || Math.abs(gesture.deltaX) <= threshold) {
    return { action: null, deltaX: 0 };
  }
  return {
    action: gesture.deltaX > 0 ? "like" : "not_interested",
    deltaX: gesture.deltaX,
  };
}
