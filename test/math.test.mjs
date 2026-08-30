import assert from "node:assert/strict";
import { add, mul } from "../src/math.mjs";

assert.equal(add(2, 3), 5);
assert.equal(add(-4, 4), 0);
assert.equal(mul(2, 3), 6);
assert.equal(mul(5, 0), 0);
console.log("fixture suite: ok");
