import { metric } from "./metric.scm";
import examples from "./examples.json";
import runPredict from "./predict.prompt";
import runImprove from "./improve.prompt";
import seed from "./seed.txt";

// Call the prompts with a content-derived cache key, so identical calls replay.
const ask = async (instruction, input) => await runPredict({ instruction, input });

const reflect = async (instruction, failures) => await runImprove({ instruction, failures });

// Score an instruction across every example, in parallel.
const evaluate = async (instruction) =>
  await Promise.all(
    examples.map(async (ex) => metric(await ask(instruction, ex.input), ex.expected)),
  );

// A candidate is an instruction together with its per-example scores.
const assess = async (instruction) => ({ instruction, scores: await evaluate(instruction) });

// A readable summary of the examples this candidate got wrong.
const failing = (candidate) =>
  examples
    .map((example, i) => [example, candidate.scores[i]])
    .filter(([first, second]) => second === 0)
    .map(([head]) => head);

// Reflective mutation: hand this candidate's failures to the reflect prompt.
const mutate = async (candidate) =>
  await assess(await reflect(candidate.instruction, failing(candidate)));

// Pareto frontier: keep every candidate no other candidate beats outright.
const dominates = (a, b) =>
  a.scores.every((score, i) => score >= b.scores[i]) &&
  a.scores.some((score, i) => score > b.scores[i]);

const frontier = (pool) => pool.filter((c) => !pool.some((other) => dominates(other, c)));

// Apply `step` to the pool `n` times.
const iterate = async (step, pool, n) =>
  n === 0 ? pool : await iterate(step, await step(pool), n - 1);

// One generation: mutate each survivor, then re-select the frontier over all.
const generation = async (pool) => frontier([...pool, ...(await Promise.all(pool.map(mutate)))]);

// Evolve from the seed for `rounds` generations; keep the best on the full set.
const gepa = async (seed, rounds) =>
  (await iterate(generation, [await assess(seed)], rounds)).reduce((acc, __x) =>
    __x.scores.reduce((acc, score) => acc + score, 0) >
    acc.scores.reduce((acc, score) => acc + score, 0)
      ? __x
      : acc,
  );

// The winning candidate — its :instruction is the optimized prompt.
await gepa(seed, 4);
