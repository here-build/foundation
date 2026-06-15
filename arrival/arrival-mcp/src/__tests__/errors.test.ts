/**
 * Unit tests for the safety-fabric kernel additions (H7):
 *   - MCPError: typed error class with discrete `kind`
 *   - classifyError: preserves MCPError, wraps others as runtime
 *   - withTimeout: race-based deadline enforcement
 *   - size limit helpers (checkSizeLimit, checkStringSize)
 */
import { describe, expect, it, vi } from "vitest";

import {
  checkSizeLimit,
  checkStringSize,
  classifyError,
  DEFAULT_SIZE_LIMITS,
  isMCPError,
  MCPError,
  withTimeout,
} from "../errors.js";

describe("MCPError", () => {
  it("constructs with kind + message + details", () => {
    const err = new MCPError("validation", "bad thing", {
      phase: "validation",
      target: "foo",
    });
    expect(err.kind).toBe("validation");
    expect(err.message).toBe("bad thing");
    expect(err.details.phase).toBe("validation");
    expect(err.details.target).toBe("foo");
  });

  it("isMCPError discriminates", () => {
    expect(isMCPError(new MCPError("runtime", "x"))).toBe(true);
    expect(isMCPError(new Error("native"))).toBe(false);
    expect(isMCPError("string")).toBe(false);
    expect(isMCPError(null)).toBe(false);
  });

  it("toJSON serializes kind + message + details", () => {
    const err = new MCPError("timeout", "too slow", { extra: { deadlineMs: 100 } });
    expect(err.toJSON()).toEqual({
      kind: "timeout",
      message: "too slow",
      details: { extra: { deadlineMs: 100 } },
    });
  });
});

describe("classifyError", () => {
  it("passes MCPError through unchanged", () => {
    const original = new MCPError("validation", "v");
    expect(classifyError(original)).toBe(original);
  });

  it("wraps native Error with runtime kind (default)", () => {
    const err = classifyError(new Error("native explosion"));
    expect(err.kind).toBe("runtime");
    expect(err.message).toBe("native explosion");
    expect(err.details.extra?.originalName).toBe("Error");
  });

  it("wraps native Error with custom fallback kind", () => {
    const err = classifyError(new Error("prepare failed"), "prepare");
    expect(err.kind).toBe("prepare");
  });

  it("wraps non-Error thrown value as runtime", () => {
    const err = classifyError("just a string");
    expect(err.kind).toBe("runtime");
    expect(err.message).toBe("just a string");
  });
});

describe("withTimeout", () => {
  it("resolves when operation completes in time", async () => {
    const result = await withTimeout(
      async () => 42,
      1_000,
      "handler",
      "fast-op",
    );
    expect(result).toBe(42);
  });

  it("rejects with MCPError(timeout) when operation exceeds deadline", async () => {
    await expect(
      withTimeout(
        () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 200)),
        50,
        "handler",
        "slow-op",
      ),
    ).rejects.toThrow(MCPError);
  });

  it("timeout error carries phase + target + deadlineMs", async () => {
    try {
      await withTimeout(
        () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 100)),
        10,
        "handler",
        "x",
      );
    } catch (e) {
      expect(isMCPError(e)).toBe(true);
      const err = e as MCPError;
      expect(err.kind).toBe("timeout");
      expect(err.details.phase).toBe("handler");
      expect(err.details.target).toBe("x");
      expect(err.details.extra?.deadlineMs).toBe(10);
    }
  });

  it("propagates operation-thrown errors (not a timeout)", async () => {
    await expect(
      withTimeout(
        async () => {
          throw new Error("op failed");
        },
        1_000,
        "handler",
      ),
    ).rejects.toThrow("op failed");
  });

  it("passes AbortSignal to operation", async () => {
    let receivedSignal: AbortSignal | null = null;
    await withTimeout(
      async (signal) => {
        receivedSignal = signal;
        return "ok";
      },
      1_000,
      "handler",
    );
    expect(receivedSignal).not.toBeNull();
    expect(receivedSignal!.aborted).toBe(false);
  });
});

describe("size-limit helpers", () => {
  it("checkSizeLimit passes when under", () => {
    expect(() => checkSizeLimit(5, 10, "actions")).not.toThrow();
    expect(() => checkSizeLimit(10, 10, "actions")).not.toThrow();
  });

  it("checkSizeLimit throws MCPError(size-limit) when over", () => {
    try {
      checkSizeLimit(11, 10, "actions", "batch");
    } catch (e) {
      expect(isMCPError(e)).toBe(true);
      const err = e as MCPError;
      expect(err.kind).toBe("size-limit");
      expect(err.message).toMatch(/actions exceeded: 11 > 10/);
      expect(err.details.target).toBe("batch");
      expect(err.details.extra).toEqual({ current: 11, max: 10 });
    }
  });

  it("checkStringSize passes under", () => {
    expect(() => checkStringSize("short", 100)).not.toThrow();
  });

  it("checkStringSize throws over", () => {
    try {
      checkStringSize("x".repeat(101), 100, "myField");
    } catch (e) {
      expect(isMCPError(e)).toBe(true);
      expect((e as MCPError).kind).toBe("size-limit");
      expect((e as MCPError).details.target).toBe("myField");
    }
  });

  it("DEFAULT_SIZE_LIMITS has expected defaults", () => {
    expect(DEFAULT_SIZE_LIMITS.maxActions).toBe(50);
    expect(DEFAULT_SIZE_LIMITS.maxPropsFields).toBe(64);
    expect(DEFAULT_SIZE_LIMITS.maxStringFieldSize).toBe(16_384);
  });
});
