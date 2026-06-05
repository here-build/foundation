# Generated from improve.prompt by @here.build/arrival-chain-view — do not edit.
import dspy

from _llm import lm

# Prompt template (model: qwen3.5-9b):
#   {{role "user"}}
#   The instruction below is underperforming. Rewrite it to fix the failures.
#   
#   Current instruction:
#   {{instruction}}
#   
#   It was wrong on these cases:
#   {{#each failures}}
#     - {{this.input}}  → expected: {{this.expected}}
#   {{/each}}
#   
#   Reply with only the improved instruction.
improve_lm = lm("qwen3.5-9b")


class Improve(dspy.Signature):
    """The instruction below is underperforming. Rewrite it to fix the failures."""

    instruction: str = dspy.InputField()
    failures: list = dspy.InputField()
    output: str = dspy.OutputField()


_improve = dspy.Predict(Improve)


def infer_improve(instruction, failures):
    with dspy.context(lm=improve_lm):
        return _improve(instruction=instruction, failures=failures).output
