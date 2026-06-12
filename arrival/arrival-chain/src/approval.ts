/**
 * The runtime half of `(run/continue-after-approval spec result)` — a
 * human-in-the-loop gate in front of an irreversible action.
 *
 * The authoring front is a preamble macro (see `SUPERDEFINE_PREAMBLE`) that
 * THUNKS the result so the to-be-approved value isn't computed until permission
 * lands:
 *
 *   (run/continue-after-approval spec result)
 *     ⇒ (approval/await spec (lambda () result))
 *
 * So the interpreter core only ever sees an ordinary call + a lambda — no
 * domain concept leaks into the pure dataflow core (the membrane rule). The
 * rosetta is async (mirroring the `infer` rosetta): it constructs a
 * {@link FunctionRunApprovalRequest}, hands it to an optional host sink
 * (`onApprovalRequest`), and AWAITS a human's verdict by observing the request's
 * `result`. On approval it CALLS the thunk (running `result` for the first time)
 * and returns its value — the go-token the downstream irreversible action
 * structurally consumes. On rejection it throws, so that branch fails and the
 * action never fires.
 *
 * The membrane/replay principle (ADR-025): every effect is a recorded membrane
 * penetration, and this approval is one more async penetration — the value only
 * crosses back once a human has signed off.
 *
 * LOCAL-FIRST: when no real approver is wired (`onApprovalRequest` absent), the
 * request auto-approves immediately so local/sandbox runs never block.
 */
import { action, makeObservable, observable, when } from "mobx";

import type { Environment } from "@here.build/arrival-scheme";

/** The form head the preamble macro lowers to. */
export const APPROVAL_FORM = "approval/await";

/** Verdict: APPROVED. Carries an optional value override (reserved — a human
 *  substituting the result) and audit metadata (`by`). */
export class FunctionRunApprovalResult {
  constructor(
    /** Audit: who approved (a principal ref). */
    readonly by?: unknown,
    /** Optional value override — when present, wins over the thunk's value.
     *  Reserved for "edit-then-approve"; absent in the plain-approve path. */
    readonly value?: unknown,
  ) {}
}

/** Verdict: REJECTED. Carries an optional reason + audit metadata. */
export class FunctionRunApprovalReject {
  constructor(
    readonly reason?: unknown,
    /** Audit: who rejected. */
    readonly by?: unknown,
  ) {}
}

/**
 * A reactive comms channel for ONE pending approval. The run awaits resolution
 * by observing `result` flip from `null` to a verdict variant. A host surfaces
 * `spec` to a human, who calls `approve(...)` or `reject(...)`.
 *
 * Invalid states are unrepresentable: `result` is the resolution itself
 * (`null` = pending · `Result` = approved · `Reject` = rejected), so "approved
 * AND rejected" cannot occur, and a reason can only ride a rejection. The two
 * mutators are the only transitions and are single-use — once `result` is set,
 * a second `approve`/`reject` is inert (late/double verdicts are dead).
 *
 * mobx-observable so a UI (or the awaiting rosetta's `when`) reacts to the
 * verdict without polling.
 */
export class FunctionRunApprovalRequest {
  /** The approval descriptor surfaced to a human (action/args/why/collect-schema). */
  readonly spec: unknown;
  /** The resolution: `null` while pending, then exactly one verdict variant. */
  result: null | FunctionRunApprovalResult | FunctionRunApprovalReject = null;

  constructor(spec: unknown) {
    this.spec = spec;
    makeObservable(this, {
      result: observable.ref,
      approve: action.bound,
      reject: action.bound,
    });
  }

  /** Approve. Optional `by` (audit) and `value` (reserved override). Inert once
   *  resolved. */
  approve(by?: unknown, value?: unknown): void {
    if (this.result) return;
    this.result = new FunctionRunApprovalResult(by, value);
  }

  /** Reject this branch with an optional reason + `by` (audit). Inert once
   *  resolved. */
  reject(reason?: unknown, by?: unknown): void {
    if (this.result) return;
    this.result = new FunctionRunApprovalReject(reason, by);
  }
}

/** Host sink for a freshly-constructed pending request. Sync or async; return
 *  ignored — the request resolves through its `result` field, not a return. */
export type OnApprovalRequest = (req: FunctionRunApprovalRequest) => void | Promise<void>;

/**
 * Optional host hook that decides a request's verdict directly (instead of, or
 * in addition to, surfacing it via `onApprovalRequest`). Return `true`/`false`
 * synchronously to approve/reject; return `undefined` to leave the verdict to
 * the async channel (`onApprovalRequest` + the observed `result`).
 */
export type ResolveApproval = (req: FunctionRunApprovalRequest) => boolean | undefined;

/** Raised when an approval is rejected — the branch fails, the action never fires. */
export class ApprovalRejected extends Error {
  constructor(readonly request: FunctionRunApprovalRequest) {
    const reject = request.result instanceof FunctionRunApprovalReject ? request.result : undefined;
    super(`approval rejected${reject?.reason ? `: ${String(reject.reason)}` : ""}`);
    this.name = "ApprovalRejected";
  }
}

/**
 * `onApprovalRequest` and `resolveApproval` are both optional — omit them and a
 * request auto-approves immediately (local/sandbox: runs never block). Same
 * "capability is optional, the verb always exists" posture as `declare/expose`
 * and `define/overridable`.
 */
export function defineApprovalRosetta(opts: {
  env: Environment;
  onApprovalRequest?: OnApprovalRequest;
  resolveApproval?: ResolveApproval;
}): void {
  const { env, onApprovalRequest, resolveApproval } = opts;
  const local = !onApprovalRequest && !resolveApproval;

  env.defineRosetta(APPROVAL_FORM, {
    fn: async (spec: unknown, thunk: unknown): Promise<unknown> => {
      if (typeof thunk !== "function") {
        throw new Error(`${APPROVAL_FORM}: result must be thunked (a (lambda () …)) — got ${typeof thunk}`);
      }
      const proc = thunk as () => unknown | Promise<unknown>;

      const req = new FunctionRunApprovalRequest(spec);

      // LOCAL AUTO-APPROVE — no real approver wired ⇒ release synchronously so
      // local runs never park.
      if (local) {
        req.approve();
      } else {
        // A host hook may decide the verdict directly.
        if (resolveApproval) {
          const verdict = resolveApproval(req);
          if (verdict === true) req.approve();
          else if (verdict === false) req.reject();
        }
        // Surface to the host UI/inbox unless already decided.
        if (req.result === null && onApprovalRequest) {
          await onApprovalRequest(req);
        }
        // TODO(ADR-025): durable teardown/resume is the next layer. Today we
        // hold the run in memory until a human resolves `result`. The durable
        // variant suspends here and resumes by replaying the effect-log.
        await when(() => req.result !== null);
      }

      if (req.result instanceof FunctionRunApprovalReject) throw new ApprovalRejected(req);

      // Approved: run `result` NOW (first evaluation) — the thunk's value is the
      // go-token the downstream irreversible action consumes. A human-supplied
      // `value` override (reserved edit-then-approve path) wins over it.
      const computed = await proc();
      const verdict = req.result as FunctionRunApprovalResult;
      return verdict.value === undefined ? computed : verdict.value;
    },
  });
}
