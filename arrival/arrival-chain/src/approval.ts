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
 * mobx fields. On approval it CALLS the thunk (running `result` for the first
 * time) and returns its value — the go-token the downstream irreversible action
 * structurally consumes. On rejection it throws, so that branch fails and the
 * action never fires.
 *
 * The membrane/replay principle (ADR-025): every effect is a recorded membrane
 * penetration, and this approval is one more async penetration — the value only
 * crosses back once a human has signed off.
 *
 * LOCAL-FIRST: when no real approver is wired (`onApprovalRequest` absent), the
 * request auto-approves immediately so local/sandbox runs never block. A host
 * that wires `onApprovalRequest` (or `resolveApproval`) takes ownership of the
 * verdict.
 *
 * NOTE: durable suspend (days-long teardown + resume-by-replay over the
 * effect-log) is the NEXT layer (ADR-025), out of scope here — local
 * auto-approve means we don't need it yet.
 */
import { action, makeObservable, observable, when } from "mobx";

import type { Environment } from "@here.build/arrival-scheme";

/** The form head the preamble macro lowers to. */
export const APPROVAL_FORM = "approval/await";

/**
 * A reactive comms channel for ONE pending approval. The run awaits resolution
 * by observing `approved || rejected`; a host surfaces `spec` to a human, who
 * may EDIT `result` (the proposed value) before flipping `approved`, or set
 * `rejected` (+ `reason`) to fail the branch.
 *
 * mobx-observable so a UI (or the awaiting rosetta) reacts to the human's edits
 * and verdict without polling.
 */
export class FunctionRunApprovalRequest {
  /** The approval descriptor surfaced to a human (action/args/why/collect-schema). */
  readonly spec: unknown;
  /** The PROPOSED value, editable before approval. The edited value is what flows. */
  result: unknown;
  /** Set true to release `result` (possibly edited). */
  approved = false;
  /** Set true to fail this branch. */
  rejected = false;
  /** Optional human-readable rejection reason. */
  reason?: string;

  constructor(spec: unknown, result: unknown) {
    this.spec = spec;
    this.result = result;
    // mobx-observable so a UI (or the awaiting rosetta's `when`) reacts to the
    // human's edits + verdict. The mutators are actions so a strict-mode host
    // (`enforceActions: "observed"`) can flip them without tripping.
    makeObservable(this, {
      result: observable.ref,
      approved: observable,
      rejected: observable,
      reason: observable.ref,
      edit: action.bound,
      approve: action.bound,
      reject: action.bound,
    });
  }

  /** Edit the proposed value before approval. */
  edit(result: unknown): void {
    this.result = result;
  }

  /** Approve, optionally replacing the proposed value with an edited one. */
  approve(result?: unknown): void {
    if (arguments.length > 0) this.result = result;
    this.approved = true;
  }

  /** Reject this branch with an optional reason. */
  reject(reason?: string): void {
    this.reason = reason;
    this.rejected = true;
  }
}

/** Host sink for a freshly-constructed pending request. Sync or async; return
 *  ignored — the request resolves through its own mobx fields, not a return. */
export type OnApprovalRequest = (req: FunctionRunApprovalRequest) => void | Promise<void>;

/**
 * Optional host hook that decides a request's verdict directly (instead of, or
 * in addition to, surfacing it via `onApprovalRequest`). Return `true`/`false`
 * synchronously to approve/reject; return `undefined` to leave the verdict to
 * the async channel (`onApprovalRequest` + observed fields).
 */
export type ResolveApproval = (req: FunctionRunApprovalRequest) => boolean | undefined;

/** Raised when an approval is rejected — the branch fails, the action never fires. */
export class ApprovalRejected extends Error {
  constructor(readonly request: FunctionRunApprovalRequest) {
    super(`approval rejected${request.reason ? `: ${request.reason}` : ""}`);
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

      const req = new FunctionRunApprovalRequest(spec, undefined);

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
        if (!req.approved && !req.rejected && onApprovalRequest) {
          await onApprovalRequest(req);
        }
        // TODO(ADR-025): durable teardown/resume is the next layer. Today we
        // hold the run in memory until a human flips `approved`/`rejected`. The
        // durable variant suspends here and resumes by replaying the effect-log.
        await when(() => req.approved || req.rejected);
      }

      if (req.rejected) throw new ApprovalRejected(req);

      // Approved: run `result` NOW (first evaluation), AND release the
      // possibly-edited proposed value when the human supplied one. The thunk's
      // value is the go-token the downstream irreversible action consumes; if
      // the human edited `result`, that edited value wins (it's the human's
      // sign-off, not the raw proposal).
      const computed = await proc();
      return req.result === undefined ? computed : req.result;
    },
  });
}
