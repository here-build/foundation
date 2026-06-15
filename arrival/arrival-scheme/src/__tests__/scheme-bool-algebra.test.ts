// Algebra cell for SchemeBool: Setoid only (booleans aren't ordered in this
// system). The domain has just two inhabitants, so symmetry/transitivity
// collide naturally — exactly the dense-collision regime that exercises the
// Setoid laws hardest.
import fc from "fast-check";
import { SchemeBool } from "../SchemeBool.js";
import { setoidLaws } from "./algebra-laws.js";

const arb = fc.boolean().map((b) => new SchemeBool(b));
const equalClone = (b: SchemeBool) => new SchemeBool(b.value);

setoidLaws("SchemeBool", { arb, equalClone });
