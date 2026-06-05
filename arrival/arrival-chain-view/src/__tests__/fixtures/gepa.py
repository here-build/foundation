import json
from metric import metric
examples = json.load(open("examples.json"))
from predict_prompt import infer_predict as run_predict
from improve_prompt import infer_improve as run_improve
seed = open("seed.txt").read()

# Call the prompts with a content-derived cache key, so identical calls replay.
def ask(instruction, input):
    return run_predict([instruction, input], instruction=instruction, input=input)

def reflect(instruction, failures):
    return run_improve([instruction, failures], instruction=instruction, failures=failures)

# Score an instruction across every example, in parallel.
def evaluate(instruction):
    return [metric(ask(instruction, ex["input"]), ex["expected"]) for ex in examples]

# A candidate is an instruction together with its per-example scores.
def assess(instruction):
    return {"instruction": instruction, "scores": evaluate(instruction)}

# A readable summary of the examples this candidate got wrong.
def failing(candidate):
    return [x[0] for x in [pair for pair in list(zip(examples, candidate["scores"])) if pair[1] == 0]]

# Reflective mutation: hand this candidate's failures to the reflect prompt.
def mutate(candidate):
    return assess(reflect(candidate["instruction"], failing(candidate)))

# Pareto frontier: keep every candidate no other candidate beats outright.
def dominates(a, b):
    return (all(_a >= _b for _a, _b in zip(a["scores"], b["scores"])) and any(_a > _b for _a, _b in zip(a["scores"], b["scores"])))

def frontier(pool):
    return [c for c in pool if not any(dominates(other, c) for other in pool)]

# Apply `step` to the pool `n` times.
def iterate(step, pool, n):
    return (pool if n == 0 else iterate(step, step(pool), (n - 1)))

# One generation: mutate each survivor, then re-select the frontier over all.
def generation(pool):
    return frontier(pool + [mutate(x) for x in pool])

# Evolve from the seed for `rounds` generations; keep the best on the full set.
def gepa(seed, rounds):
    return max(iterate(generation, [assess(seed)], rounds), key=lambda c: sum(c["scores"]))

# The winning candidate — its :instruction is the optimized prompt.
gepa(seed, 4)
