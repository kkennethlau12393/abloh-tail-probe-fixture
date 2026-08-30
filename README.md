# abloh tail probe fixture

This repository is an INSTRUMENT, not a project. It exists so that `product/apps/tail-probe`
can run abloh's shipped Action on real GitHub - real identity issuance, real artifact handling,
real job scheduling - which is the slice the local rehearsal rig names in its own gaps table and
structurally cannot reach.

Everything here is generated. Do not edit it by hand: the next probe pass overwrites it, and a
hand edit would make one pass incomparable with every other one. `probe-stamp.json` says which
revision of the product generated what is here.

The five task scenarios and the sixth this rig splits out are declared in
`product/apps/tail-probe/src/scenarios.mjs`, and the deviations from what a customer's repository
would carry are named at the top of `product/apps/tail-probe/src/fixture.mjs`.
