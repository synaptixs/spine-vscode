# Fixture repository

`.repo/` is a tiny Python + TypeScript project the contract and integration tests point Spine at.
The leading dot is load-bearing: Spine's walkers skip dot-directories, so if anyone runs Spine on
this extension repo the fixture's symbols do not land in its graph (Spine's `corpus/` trap).
