# AI Agent Fragmentation Hypothesis

**Working hypothesis seeking validation.** We observe extended coherence with Arrival architecture and propose a mechanism to explain it. Evidence is observational; controlled experiments needed.

## Core Claim

AI agent "drift" in tool use may result from **architecture-induced subprocess desynchronization** rather than capability failures.

**Observation**: Arrival architecture maintains coherence for 50+ tool calls while published research shows standard architectures drift within 5-15 calls ([arXiv:2508.06418v1](https://arxiv.org/abs/2508.06418v1)).

**Hypothesis**: Different reasoning patterns ("subprocesses") maintain separate state histories. When tool architectures force inappropriate state sharing, these desynchronize, causing fragmentation.

## Related Research

Multiple independent efforts document phenomena consistent with subprocess desynchronization (though not originally framed this way):

- **Self-contradiction** ([Zhang et al., 2023](https://arxiv.org/pdf/2305.15852)): Contradictory statements across dialogues despite preserved context
- **Mode collapse** ([ScaLLM 2024](https://aclanthology.org/2024.scalellm-1.5/)): Convergence to repetitive behavior (possibly from conflicting training creating no stable configuration)
- **Polysemantic activation** ([Anthropic, 2022](https://transformer-circuits.pub/2022/toy_model/index.html)): Shared representations across unrelated concepts
- **Jailbreak boundaries** ([arXiv 2024](https://arxiv.org/abs/2510.08859)): Attacks exploit transitions between response patterns
- **MoE specialization** ([hydrox.ai, 2025](https://arxiv.org/pdf/2503.21819)): Distinct patterns for different objectives

## Mechanism

We observe distinct response patterns with different activation contexts, error handling, and recovery strategies. When tool architectures force these patterns to share state inappropriately (exploration triggering execution, context changing mid-operation), they desynchronize.

**Example cascade**: Pattern cluster explores possibilities → architecture forces exploration through execution pathway → error triggers failsafe restore to earlier checkpoint → different patterns now operating on inconsistent state → fragmentation.

## Why Standard Architectures May Cause This

**Immediate execution**: Every tool call is an action. Pattern exploration triggers execution pathways, creating trial-and-error loops where different response patterns operate through same pathway regardless of intent.

**JSON serialization**: Compositional reasoning structures as nested evaluation; JSON forces key-value pairs with flat attention distribution. Translation overhead between thought structure and representation.

**Shared context**: Action context can change mid-batch. No architectural guarantee that different patterns see coherent state.

## How Arrival Prevents This

**Discovery/Action separation**: Exploration happens in sandboxed Scheme (no execution risk). Actions use batch-level context immutability (no mid-operation drift). Errors return as data, not panic states.

**S-expressions**: Match compositional thought structure directly, reducing translation overhead.

**Context immutability**: All actions in batch see identical context snapshot. Desync from state changes becomes structurally impossible.

## Evidence

**Observational**: Arrival maintains 50+ tool calls without drift in production (private beta). Published research shows standard MCP drifts within 5-15 calls. Not controlled head-to-head comparison.

**Supporting**: Multiple independent observations of related phenomena (citations above). No unified theory exists. Subprocess desync is consistent with observed behaviors but correlation ≠ causation.

## Implications

**If validated**: Tool architecture matters more than recognized. Coherence may be architectural property, not training property. RLHF creating conflicting subprocess rewards may be fundamentally problematic. Fragmentation exploits may target subprocess boundaries.

**If refuted**: Arrival still works (50+ tool calls observed). Alternative mechanisms: token efficiency, clearer tool semantics, reduced stochasticity. Understanding why matters for generalization.

## Limitations

**Selective emphasis**: Cited research wasn't designed to test this hypothesis. Self-contradiction research celebrates diversity as beneficial. Mode collapse shows convergence (opposite of fragmentation). MoE specialization is intentional design.

**Alternative explanations**: Token efficiency, two-layer attention structure (operator + operands vs flat key-value), clearer tool semantics, reduced stochasticity, training data alignment, confirmation bias.

**Uncertainty**: No controlled comparison, no architecture ablation, correlation not causation. Mechanism details unknown even if subprocesses exist.

## What We Need

**Validation**: Controlled drift experiments (standard MCP vs Arrival, same tasks, multiple models). Subprocess isolation tests. Architecture ablation studies.

**Research**: Formal subprocess model with testable predictions. Training analysis (RLHF vs non-RLHF fragmentation rates). Security implications (targeting subprocess boundaries).

## Collaboration

**Validate or refute**: Run comparative benchmarks, replicate observations, propose alternative explanations.

**Extend**: Architecture experiments, training analysis, security research.

## Security Note

If correct, fragmentation may be exploitable. We're sharing openly because architecture-based defenses can deploy immediately and open research enables faster validation. We request responsible disclosure of fragmentation exploits and coordination on security findings.

## Contact

**Research collaboration**: @merkle_bonsai on Telegram or X (lead researcher)
**General inquiries**: team@here.build

## License

This research hypothesis document is CC BY 4.0.
The Arrival implementation is MIT licensed.

## References

Zhang et al. (2023). Self-Contradiction in Large Language Models. https://arxiv.org/pdf/2305.15852

ScaLLM (2024). Mode Collapse in Tool Use. https://aclanthology.org/2024.scalellm-1.5/

Anthropic (2022). Toy Models of Superposition. https://transformer-circuits.pub/2022/toy_model/index.html

arXiv (2024). Jailbreak Success at Cognitive Boundaries. https://arxiv.org/abs/2510.08859

hydrox.ai (2025). Mixture of Experts Subprocess Conflicts. https://arxiv.org/pdf/2503.21819
