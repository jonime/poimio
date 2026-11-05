import { describe, expect, it } from "vitest";
import { beginSwipe, finishSwipe, moveSwipe } from "./swipe-gesture.ts";

describe("swipe gesture decisions", () => {
  it("locks horizontal after slop when horizontal movement dominates", () => {
    const gesture = moveSwipe(beginSwipe(100, 100, 200), 112, 104);
    expect(gesture).toMatchObject({ lock: "horizontal", deltaX: 12 });
    expect(moveSwipe(gesture, 120, 150).deltaX).toBe(20);
  });

  it("leaves vertical movement to the browser once vertical wins the lock", () => {
    const gesture = moveSwipe(beginSwipe(100, 100, 200), 104, 112);
    expect(gesture).toMatchObject({ lock: "vertical", deltaX: 0 });
    expect(moveSwipe(gesture, 150, 120)).toMatchObject({
      lock: "vertical",
      deltaX: 0,
    });
    expect(finishSwipe(gesture).action).toBeNull();
  });

  it("commits right swipes as Like only past 40 percent", () => {
    const gesture = moveSwipe(beginSwipe(0, 0, 200), 82, 2);
    expect(finishSwipe(gesture).action).toBe("like");
    expect(finishSwipe(moveSwipe(beginSwipe(0, 0, 200), 80, 0)).action).toBeNull();
    expect(finishSwipe(moveSwipe(beginSwipe(0, 0, 200), 78, 0)).action).toBeNull();
  });

  it("commits left swipes as Not interested only past 40 percent", () => {
    const gesture = moveSwipe(beginSwipe(200, 0, 200), 118, 2);
    expect(finishSwipe(gesture).action).toBe("not_interested");
    expect(finishSwipe(moveSwipe(beginSwipe(200, 0, 200), 120, 0)).action).toBeNull();
  });

  it("cancels a gesture that never establishes a horizontal lock", () => {
    const gesture = moveSwipe(beginSwipe(0, 0, 200), 8, 2);
    expect(gesture.lock).toBe("undecided");
    expect(finishSwipe(gesture)).toEqual({ action: null, deltaX: 0 });
  });
});
