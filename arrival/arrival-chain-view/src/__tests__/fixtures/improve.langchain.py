# Generated from improve.prompt by @here.build/arrival-chain-view — do not edit.
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

from _llm import chat_model

prompt = ChatPromptTemplate.from_messages([
    ("user", "\n".join([
        "The instruction below is underperforming. Rewrite it to fix the failures.",
        "",
        "Current instruction:",
        "{instruction}",
        "",
        "It was wrong on these cases:",
        "{failures}",
        "",
        "Reply with only the improved instruction."
    ])),
])
chain = prompt | chat_model("qwen3.5-9b") | StrOutputParser()


def infer_improve(instruction, failures):
    failures = "\n".join(f"  - {it['input']}  → expected: {it['expected']}" for it in failures)
    return chain.invoke({"instruction": instruction, "failures": failures})
